// Turns a rendered article into the chunk list the audiobook is built from.
//
// One chunk per sentence, deliberately: the chunk boundary is where a pause
// can live, and pauses between sentences are most of what separates an
// audiobook from a screen reader. Merging sentences to save model calls would
// silently delete those pauses.
//
// Every chunk carries offsets into the same normalized text that anchors
// highlights, so the word being spoken, the word being painted, and the word
// under a click are all the same coordinate space by construction.

import { buildTextIndex, type TextIndex } from "@/lib/highlights";
import {
  endsWithAbbreviation,
  planSpeech,
  RISE_REVISION,
  type ChunkRole,
  type SpeechPlan,
} from "@/lib/tts/prosody";
import type { Chunk, Scales, WordSpan } from "@/lib/tts/types";

// Read-aloud skips what only makes sense on screen. Block code is noise read
// aloud and captions describe an image the listener isn't looking at. Inline
// <code> stays — it usually carries the noun of the sentence.
export const TTS_OPAQUE = ".math, [data-hl-chip], pre, figcaption";

const BLOCK =
  "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, td, th, dd, dt";

// Author emphasis. Reader highlights are deliberately absent: <mark> is
// something the reader put there, and it would be strange for the voice to
// stress a phrase back at the person who highlighted it.
const EMPHASIS = "strong, b, em, i";

// Milliseconds of silence after a chunk, by the boundary that follows it.
// Tuned by ear against commercial audiobooks: the paragraph beat is the one
// that carries most of the "this is a real reading" feeling.
const GAP = {
  // Between the halves of one sentence that was too long to synthesize whole.
  // A sentence break's worth of silence here is what made a split audible:
  // the listener hears two short sentences where the page has one long one.
  clause: 140,
  sentence: 260,
  paragraph: 700,
  headingBefore: 900,
  headingAfter: 520,
  list: 320,
  quote: 520,
  section: 1200,
  end: 0,
} as const;

// A lone "Yes." synthesizes with mangled prosody, so fragments below this
// join the next sentence in the same block. The cost is one lost micro-pause;
// the alternative is an audibly clipped word.
const MIN_CHARS = 12;
// Past this, intra-chunk word interpolation drifts too far from the truth,
// so long sentences are split at clause boundaries.
const MAX_CHARS = 320;

const HAS_SPEECH = /[\p{L}\p{N}]/u;

export interface Segmentation {
  index: TextIndex;
  chunks: Chunk[];
  text: string;
}

interface Span {
  start: number;
  end: number;
}

interface Sentence extends Span {
  // Produced by dividing an over-long sentence: this span continues the one
  // before it rather than opening a new one.
  continues: boolean;
}

function segmenter(granularity: "sentence" | "word"): Intl.Segmenter {
  return new Intl.Segmenter(undefined, { granularity });
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

// Splits an over-long sentence at clause boundaries, preferring the break
// nearest the middle so the halves stay balanced.
function splitLong(text: string, span: Span): Span[] {
  if (span.end - span.start <= MAX_CHARS) return [span];

  const mid = (span.start + span.end) / 2;
  const from = span.start + MIN_CHARS;
  const to = span.end - MIN_CHARS;

  const nearestMatch = (pattern: RegExp) => {
    let at = -1;
    for (let i = from; i < to; i++) {
      if (!pattern.test(text[i])) continue;
      if (at === -1 || Math.abs(i - mid) < Math.abs(at - mid)) at = i;
    }
    return at;
  };

  // A clause boundary is the good break. Failing that the sentence still has
  // to be broken: the phonemizer is handed one chunk at a time inside a heap
  // fixed at 16MB, and text with no punctuation in it is not text it can be
  // trusted with whole. Word boundaries next, and if there aren't any, the
  // middle — at that point it is one enormous token and any cut is arbitrary.
  let best = nearestMatch(/[,;:—–]/);
  if (best === -1) best = nearestMatch(/\s/);
  if (best === -1) best = Math.floor(mid);

  return [
    ...splitLong(text, trimSpan(text, { start: span.start, end: best + 1 })),
    ...splitLong(text, trimSpan(text, { start: best + 1, end: span.end })),
  ];
}

// Segments one block's slice, in document coordinates.
function sentenceSpans(text: string, from: number, to: number): Sentence[] {
  const slice = text.slice(from, to);
  const raw: Span[] = [];
  for (const seg of segmenter("sentence").segment(slice)) {
    const span = trimSpan(text, {
      start: from + seg.index,
      end: from + seg.index + seg.segment.length,
    });
    if (span.end > span.start && HAS_SPEECH.test(text.slice(span.start, span.end))) {
      raw.push(span);
    }
  }
  // Intl follows UAX #29, which has no abbreviation dictionary: a period, a
  // space and a capital is a sentence break by rule, so "…said Mr. Smith."
  // arrives here as two. Left alone that becomes two chunks — a full pause and
  // a terminal fall on "Mr." — whenever the first half is long enough to escape
  // the short-fragment fold below.
  //
  // Rejoining can only ever cost a pause: an abbreviation that really did end a
  // sentence produces one long chunk instead of two, and splitLong divides it
  // again if it runs past the limit.
  const joined: Span[] = [];
  for (const span of raw) {
    const previous = joined[joined.length - 1];
    if (previous && endsWithAbbreviation(text.slice(previous.start, previous.end))) {
      joined[joined.length - 1] = { start: previous.start, end: span.end };
    } else {
      joined.push(span);
    }
  }

  return joined.flatMap((span) =>
    splitLong(text, span).map((part, i) => ({ ...part, continues: i > 0 }))
  );
}

function wordSpans(text: string, span: Span): WordSpan[] {
  const words: WordSpan[] = [];
  const slice = text.slice(span.start, span.end);
  for (const seg of segmenter("word").segment(slice)) {
    if (!seg.isWordLike) continue;
    words.push({
      start: span.start + seg.index,
      end: span.start + seg.index + seg.segment.length,
    });
  }
  return words;
}

function normAt(index: TextIndex, rawPos: number): number {
  if (rawPos >= index.rawToNorm.length) return index.norm.length;
  return index.rawToNorm[Math.max(0, rawPos)];
}

interface BlockRun {
  element: Element | null;
  start: number;
  end: number;
}

// The text index concatenates text nodes with nothing between them, so in
// normalized text a heading runs straight into the paragraph below it
// ("…Sits HereItem one…"). Sentence segmentation can't see that boundary, and
// neither can a listener. Grouping the index into block runs first means every
// block is segmented on its own and can never share a chunk with another.
function blockRuns(index: TextIndex): BlockRun[] {
  const runs: BlockRun[] = [];
  for (const { node, start } of index.nodes) {
    const element = node.parentElement?.closest(BLOCK) ?? null;
    const from = normAt(index, start);
    const to = normAt(index, start + node.data.length);
    const last = runs[runs.length - 1];
    if (last && last.element === element) last.end = Math.max(last.end, to);
    else runs.push({ element, start: from, end: to });
  }
  return runs;
}

// Author emphasis in normalized coordinates. Text nodes under the same
// emphasis element merge, so a phrase broken across nodes — bold text with a
// link inside it — stays one span rather than several unusable fragments.
function emphasisRuns(index: TextIndex): WordSpan[] {
  const runs: { element: Element; start: number; end: number }[] = [];
  for (const { node, start } of index.nodes) {
    const element = node.parentElement?.closest(EMPHASIS);
    if (!element) continue;
    const from = normAt(index, start);
    const to = normAt(index, start + node.data.length);
    const last = runs[runs.length - 1];
    if (last && last.element === element) last.end = Math.max(last.end, to);
    else runs.push({ element, start: from, end: to });
  }
  return runs.map(({ start, end }) => ({ start, end }));
}

function isHeading(el: Element | null): boolean {
  return !!el && /^H[1-6]$/.test(el.tagName);
}

function inQuote(el: Element | null): boolean {
  return !!el?.closest("blockquote");
}

function roleOf(el: Element | null): ChunkRole {
  if (isHeading(el)) return "heading";
  if (inQuote(el)) return "quote";
  if (el?.tagName === "LI") return "list";
  return "body";
}

// True when a thematic break sits between the two blocks in document order —
// the one boundary that earns a full beat of silence.
function hrBetween(rules: Element[], from: Element, to: Element): boolean {
  return rules.some(
    (hr) =>
      from.compareDocumentPosition(hr) & Node.DOCUMENT_POSITION_FOLLOWING &&
      to.compareDocumentPosition(hr) & Node.DOCUMENT_POSITION_PRECEDING
  );
}

function gapBetween(
  rules: Element[],
  current: Element | null,
  next: Element | null,
  nextContinues: boolean
): number {
  if (!next) return GAP.end;
  // Checked before anything structural: a continuation is always inside the
  // block it came from, and the boundary it sits on is a comma rather than a
  // full stop however that block is laid out.
  if (nextContinues) return GAP.clause;
  if (current && current === next) return GAP.sentence;
  if (!current) return GAP.paragraph;

  if (hrBetween(rules, current, next)) return GAP.section;
  if (isHeading(next)) return GAP.headingBefore;
  if (isHeading(current)) return GAP.headingAfter;
  if (inQuote(current) !== inQuote(next)) return GAP.quote;
  if (next.tagName === "LI" || current.tagName === "LI") return GAP.list;
  return GAP.paragraph;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function scaleTag({ length, noise, noiseW }: Scales): string {
  return `${length}/${noise}/${noiseW}`;
}

// Empty for a chunk with no rise in it, so the revision only ever invalidates
// the sentences it actually describes.
function riseTag(rises: number[]): string {
  return rises.length === 0 ? "" : `${RISE_REVISION}:${rises.join(",")}`;
}

// Everything that decides what a chunk sounds like, and nothing that doesn't.
// The scales belong in the key as much as the words do: the same sentence read
// as a heading and read as a body line are two different recordings, and one
// must never be served in place of the other.
//
// NUL separates the fields because it is the one character the normalized text
// cannot contain, so no sentence can spell its way into another chunk's key.
function chunkKey(plan: SpeechPlan, voiceId: string, model: string) {
  return sha256(
    `${model}\0${voiceId}\0${scaleTag(plan.scales)}\0${riseTag(
      plan.rises
    )}\0${plan.text}`
  );
}

export async function segmentArticle(
  root: HTMLElement,
  voiceId: string,
  model: string
): Promise<Segmentation> {
  const index = buildTextIndex(root, TTS_OPAQUE);
  const text = index.norm;
  const rules = Array.from(root.querySelectorAll("hr"));
  const emphasis = emphasisRuns(index);

  const spans: Sentence[] = [];
  const blocks: (Element | null)[] = [];

  for (const run of blockRuns(index)) {
    const sentences = sentenceSpans(text, run.start, run.end);

    // Fold short fragments forward, so the model never sees a one-word
    // utterance on its own — a lone "Yes." synthesizes with mangled prosody.
    // Confined to the block, which is what the run loop already guarantees.
    for (const span of sentences) {
      const previous = spans[spans.length - 1];
      const merges =
        previous &&
        blocks[blocks.length - 1] === run.element &&
        previous.end - previous.start < MIN_CHARS;
      if (merges) {
        // The merged span inherits the opening half's standing: what decides
        // its delivery is whether it began a sentence, not where it ends.
        spans[spans.length - 1] = {
          start: previous.start,
          end: span.end,
          continues: previous.continues,
        };
      } else {
        spans.push(span);
        blocks.push(run.element);
      }
    }
  }

  const chunks = await Promise.all(
    spans.map(async (span, i) => {
      const body = text.slice(span.start, span.end);
      const words = wordSpans(text, span);
      const plan = planSpeech({
        text: body,
        words,
        normStart: span.start,
        // A continuation is mid-sentence whatever block it sits in, so it wins
        // over the block's own role.
        role: span.continues ? "clause" : roleOf(blocks[i]),
        emphasis: emphasis
          .filter((mark) => mark.start < span.end && mark.end > span.start)
          .map((mark) => ({
            start: Math.max(mark.start, span.start),
            end: Math.min(mark.end, span.end),
          })),
      });

      return {
        key: await chunkKey(plan, voiceId, model),
        text: body,
        normStart: span.start,
        normEnd: span.end,
        words,
        speech: plan.text,
        speechWords: plan.words,
        scales: plan.scales,
        rises: plan.rises,
        gapAfter: gapBetween(
          rules,
          blocks[i],
          blocks[i + 1] ?? null,
          spans[i + 1]?.continues ?? false
        ),
      } satisfies Chunk;
    })
  );

  return { index, chunks, text };
}

// Identifies the article's spoken content. A trim, a Restore, or an edit
// changes it and the cached audiobook is rebuilt rather than played against
// text it no longer matches.
//
// How the content is delivered is part of that identity, not a detail beneath
// it: a manifest adopted from disk brings its own speech text, scales and gaps
// with it, so a change to any of them has to be a different article as far as
// adoption is concerned, or the reader keeps yesterday's reading forever.
export function contentHash(chunks: Chunk[]): Promise<string> {
  return sha256(
    chunks
      .map(
        (c) =>
          `${c.text}\0${c.speech}\0${scaleTag(c.scales)}\0${riseTag(
            c.rises
          )}\0${c.gapAfter}`
      )
      .join("\n")
  );
}
