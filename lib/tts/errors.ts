// How a failed synthesis is read, on both sides of the worker boundary.
//
// The distinction that matters is whether the engine failed because of the
// machine or because of the text, because the two have opposite repairs: the
// machine wants a fresh heap and another go, the text wants to be broken up
// and never asked again in the form that failed.

// An exhausted wasm heap reads as an allocation failure somewhere inside the
// engine. The model is the largest single thing it allocates, so this is the
// shape it usually takes:
//
//   Can't create a session. failed to allocate a buffer of size 63201294.
//
// A wasm heap can grow but never shrink, and it dies only with the thread that
// owns it, so there is no recovering in place — which is what makes this worth
// catching rather than just reporting.
//
// `Aborted(OOM)` belongs here too: that is the phonemizer, whose heap is a
// fixed 16MB, saying it needed more. Bare `Aborted()` does not — see
// lib/tts/worker.ts, which is where that one is dealt with.
const OUT_OF_MEMORY =
  /failed to allocate|out of memory|cannot enlarge memory|memory access out of bounds|abort(ed)?\(oom/i;

export function isOutOfMemory(message: string): boolean {
  return OUT_OF_MEMORY.test(message);
}
