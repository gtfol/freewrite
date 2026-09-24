// Storage codec for generated speech.
//
// Raw 24kHz PCM16 runs 48KB/s — a twenty-minute article is ~57MB, which no
// browser quota survives across a reading list. Opus at 24kbps is ~3KB/s for
// speech that still sounds like the model output, so WebCodecs is the default
// and raw PCM is the fallback where it isn't available.

const OPUS_RATE = 48000;
const OPUS_BITRATE = 24000;
const MAGIC = 0x4f505553; // "OPUS"

export interface EncodedAudio {
  format: "opus" | "pcm";
  data: ArrayBuffer;
  sampleRate: number;
  duration: number;
}

// Samples backed by a plain ArrayBuffer. The DOM audio APIs reject the
// SharedArrayBuffer-compatible default that a bare Float32Array widens to.
export type Samples = Float32Array<ArrayBuffer>;

type WebCodecsGlobal = {
  AudioEncoder?: typeof AudioEncoder;
  AudioDecoder?: typeof AudioDecoder;
  AudioData?: typeof AudioData;
  EncodedAudioChunk?: typeof EncodedAudioChunk;
};

function codecs(): WebCodecsGlobal {
  return globalThis as unknown as WebCodecsGlobal;
}

export function opusSupported(): boolean {
  const { AudioEncoder: enc, AudioDecoder: dec, AudioData: data } = codecs();
  return !!enc && !!dec && !!data;
}

// Linear resampling is well below the noise floor of a 24kbps speech codec,
// and it avoids OfflineAudioContext, which workers don't get.
function resample(audio: Float32Array, from: number, to: number): Samples {
  if (from === to) {
    const same = new Float32Array(audio.length);
    same.set(audio);
    return same;
  }
  const ratio = to / from;
  const out = new Float32Array(Math.round(audio.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(audio.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = audio[i0] * (1 - t) + audio[i1] * t;
  }
  return out;
}

function toPcm16(audio: Float32Array): ArrayBuffer {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const clamped = Math.max(-1, Math.min(1, audio[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

function fromPcm16(buffer: ArrayBuffer): Samples {
  const src = new Int16Array(buffer);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 0x8000;
  return out;
}

// Minimal container: raw Opus packets need framing to survive a round trip
// through IndexedDB, and a full Ogg muxer would be a dependency for nothing.
//   magic u32 | packets u32 | frames u32 | [ length u32, durationUs u32, bytes ]
function pack(packets: Uint8Array[], durations: number[], frames: number): ArrayBuffer {
  const size =
    12 + packets.reduce((sum, p) => sum + 8 + p.byteLength, 0);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, MAGIC);
  view.setUint32(4, packets.length);
  view.setUint32(8, frames);

  let at = 12;
  for (let i = 0; i < packets.length; i++) {
    view.setUint32(at, packets[i].byteLength);
    view.setUint32(at + 4, durations[i]);
    bytes.set(packets[i], at + 8);
    at += 8 + packets[i].byteLength;
  }
  return buffer;
}

function unpack(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0) !== MAGIC) throw new Error("not an opus payload");

  const count = view.getUint32(4);
  const frames = view.getUint32(8);
  const packets: { data: Uint8Array; duration: number }[] = [];

  let at = 12;
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(at);
    const duration = view.getUint32(at + 4);
    packets.push({
      data: new Uint8Array(buffer, at + 8, length),
      duration,
    });
    at += 8 + length;
  }
  return { packets, frames };
}

async function encodeOpus(
  audio: Float32Array,
  sampleRate: number
): Promise<EncodedAudio> {
  const { AudioEncoder: Encoder, AudioData: Data } = codecs();
  if (!Encoder || !Data) throw new Error("WebCodecs unavailable");

  const config: AudioEncoderConfig = {
    codec: "opus",
    sampleRate: OPUS_RATE,
    numberOfChannels: 1,
    bitrate: OPUS_BITRATE,
  };
  const support = await Encoder.isConfigSupported(config);
  if (!support.supported) throw new Error("opus unsupported");

  const pcm = resample(audio, sampleRate, OPUS_RATE);
  const packets: Uint8Array[] = [];
  const durations: number[] = [];

  await new Promise<void>((resolve, reject) => {
    const encoder = new Encoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        packets.push(bytes);
        durations.push(chunk.duration ?? 0);
      },
      error: reject,
    });
    encoder.configure(config);
    encoder.encode(
      new Data({
        format: "f32-planar",
        sampleRate: OPUS_RATE,
        numberOfFrames: pcm.length,
        numberOfChannels: 1,
        timestamp: 0,
        data: pcm,
      })
    );
    encoder
      .flush()
      .then(() => {
        encoder.close();
        resolve();
      })
      .catch(reject);
  });

  return {
    format: "opus",
    data: pack(packets, durations, pcm.length),
    sampleRate: OPUS_RATE,
    duration: audio.length / sampleRate,
  };
}

async function decodeOpus(record: {
  data: ArrayBuffer;
  sampleRate: number;
}): Promise<Samples> {
  const { AudioDecoder: Decoder, EncodedAudioChunk: Chunk } = codecs();
  if (!Decoder || !Chunk) throw new Error("WebCodecs unavailable");

  const { packets, frames } = unpack(record.data);
  const out = new Float32Array(frames);
  let written = 0;

  await new Promise<void>((resolve, reject) => {
    const decoder = new Decoder({
      output: (data) => {
        const size = data.numberOfFrames;
        const scratch = new Float32Array(size);
        data.copyTo(scratch, { planeIndex: 0, format: "f32-planar" });
        // A decoder can return more frames than we asked for (the codec's
        // pre-skip); dropping the overflow keeps duration honest.
        const room = Math.min(size, out.length - written);
        if (room > 0) out.set(scratch.subarray(0, room), written);
        written += room;
        data.close();
      },
      error: reject,
    });
    decoder.configure({
      codec: "opus",
      sampleRate: record.sampleRate,
      numberOfChannels: 1,
    });

    let timestamp = 0;
    for (const packet of packets) {
      decoder.decode(
        new Chunk({
          type: "key",
          timestamp,
          duration: packet.duration,
          data: packet.data,
        })
      );
      timestamp += packet.duration;
    }
    decoder
      .flush()
      .then(() => {
        decoder.close();
        resolve();
      })
      .catch(reject);
  });

  return out.subarray(0, written);
}

export async function encodeAudio(
  audio: Float32Array,
  sampleRate: number
): Promise<EncodedAudio> {
  if (opusSupported()) {
    try {
      return await encodeOpus(audio, sampleRate);
    } catch {
      // Fall through — a device without a working Opus encoder still gets an
      // audiobook, just a heavier one.
    }
  }
  return {
    format: "pcm",
    data: toPcm16(audio),
    sampleRate,
    duration: audio.length / sampleRate,
  };
}

export async function decodeAudio(record: {
  format: "opus" | "pcm";
  data: ArrayBuffer;
  sampleRate: number;
}): Promise<{ audio: Samples; sampleRate: number }> {
  if (record.format === "pcm") {
    return { audio: fromPcm16(record.data), sampleRate: record.sampleRate };
  }
  return {
    audio: await decodeOpus(record),
    sampleRate: record.sampleRate,
  };
}
