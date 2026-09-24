// Text that has no pronunciation, and what to do about it.
//
// Read aloud, a URL is twenty seconds of letters. A hash is worse, and a
// rendered formula is worse still — KaTeX leaves its markup behind as plain
// text, often twice over, so a single equation arrives here as three hundred
// characters of operators and Greek that espeak will happily name one at a
// time for a minute and a half.
//
// None of it is a failure of the voice. It is text that was never speech, and
// the only good reading of it is not to read it. Two levels:
//
//   - A token nobody could say — a URL, a hash, a base64 blob, an id — is cut
//     out of the sentence around it, so "See https://…/x for details" is read
//     as "See for details" rather than spelled out in the middle.
//   - A chunk that is mostly such text is dropped entirely, before it ever
//     becomes audio. The formula, the coordinate pair, the "2/5" under a
//     figure: there is no sentence in there to save.
//
// Skipping is already a supported state — a sentence the engine refuses leaves
// a gap and the reading moves on — so a dropped chunk costs nothing but the
// silence it would have been.
//
// Relative imports with extensions, so this runs under `npm test` without a
// bundler. See speakable.test.ts.

import type { WordSpan } from "./types.ts";

// Operators, arrows, letterlike symbols, sub- and superscripts, and the
// mathematical alphabets. Greek is in here too: in an English article a lone
// theta is a variable far more often than it is Greek.
const MATH_CHAR =
  /[\u{2190}-\u{21FF}\u{2200}-\u{22FF}\u{2A00}-\u{2AFF}\u{27C0}-\u{27EF}\u{2100}-\u{214F}\u{2070}-\u{209F}\u{0370}-\u{03FF}\u{1D400}-\u{1D7FF}]/u;

const LETTER = /\p{L}/u;

// Enough of these that "α, β, and γ are the angles" stays a sentence and a
// gradient expression does not.
const MIN_MATH_CHARS = 6;
const MAX_MATH_SHARE = 0.08;
// Below this a chunk is more punctuation and digits than language.
const MIN_LETTER_SHARE = 0.5;
// A single unbroken run this long, taking up this much of the chunk, is one
// object rather than a sentence about one.
const MIN_BLOB_CHARS = 40;
const MAX_BLOB_SHARE = 0.5;

// Anything with a scheme on it, and the two schemeless forms people write.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAILTO = /^(?:mailto:|[^\s@]+@[^\s@]+\.[a-z]{2,}$)/i;
const WWW = /^www\d?\./i;
// A path with no host: "/blog/softrain.htm", "~/notes", "./build".
const PATH = /^[~.]{0,2}\/[^\s]{2,}$/;
// Windows, and anything with enough slashes to be a location rather than a
// fraction.
const WINDOWS_PATH = /^[a-z]:\\|^\\\\/i;

// Bare hosts, which need a plausible last segment or every "e.g" and "Mr.Smith"
// becomes a domain.
const TLD =
  /\.(?:com|org|net|edu|gov|mil|int|io|co|ai|dev|app|me|tv|fm|ly|sh|xyz|info|biz|news|blog|uk|us|ca|au|de|fr|es|it|nl|se|no|fi|dk|pl|ru|jp|cn|kr|in|br|mx|ch|at|be|nz|za)$/i;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/i;

const HEX = /^(?:0x)?[0-9a-f]{16,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Long, mixed, and drawn from exactly the base64 alphabet.
const BASE64 = /^[A-Za-z0-9+/]{24,}={0,2}$/;
// Digits and separators, and enough of them to be an identifier rather than
// something a reader would say. Counting the digits rather than the length is
// what keeps "2024-07-29" (eight) and "1,250,000" (seven) out of it while
// "+1-555-0142-9987" (twelve) lands. A lone decimal is never in here — "3.14159"
// is a number someone wrote on purpose, and a coordinate pair has no letters in
// it at all, so the chunk-level test drops it without needing a token rule.
const DIGIT_TOKEN = /^[+#]?\d[\d\-._/,]*$/;
const MIN_IDENTIFIER_DIGITS = 9;

const VOWEL = /[aeiouyÀ-ÿ]/i;

// Punctuation a token may be wrapped in without changing what it is. Wrapping
// goes when the token goes — a lone "(" left behind is its own small noise —
// but sentence punctuation stays, because the comma in "See <url>, then leave"
// belongs to the sentence rather than to the link.
const OPENERS = /^[([{<"'“‘«]+/;
const WRAPPERS = /[)\]}>"'”’»]+$/;
const SENTENCE_PUNCTUATION = /[,;:.!?…]+$/;

function unspeakableToken(token: string): boolean {
  if (token.length < 2) return false;

  if (SCHEME.test(token)) return true;
  if (WWW.test(token)) return true;
  if (MAILTO.test(token)) return true;
  if (PATH.test(token)) return true;
  if (WINDOWS_PATH.test(token)) return true;

  // A host, with or without a path hanging off it.
  const [host, ...rest] = token.split("/");
  if (HOST.test(host) && (TLD.test(host) || rest.length > 0)) {
    // A path makes it a location; without one it needs a real-looking TLD, or
    // "Mr.Smith" and "e.g" qualify.
    if (TLD.test(host)) return true;
  }

  if (UUID.test(token)) return true;
  if (HEX.test(token)) return true;
  if (BASE64.test(token) && /\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token)) {
    return true;
  }
  if (
    DIGIT_TOKEN.test(token) &&
    (token.match(/\d/g)?.length ?? 0) >= MIN_IDENTIFIER_DIGITS
  ) {
    return true;
  }

  // A long word with no vowel in it is not a word. Acronyms are short, and
  // this has to stay clear of "rhythms" and "strengths".
  if (token.length >= 9 && LETTER.test(token) && !VOWEL.test(token)) return true;

  return false;
}

// The stretches of `text` that should never reach the engine, in order and
// non-overlapping. Trailing whitespace comes with them so removing one doesn't
// leave a gap where a word was.
export function unspeakableSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];

  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const from = match.index;

    const lead = OPENERS.exec(raw)?.[0].length ?? 0;
    const body = raw.slice(lead);
    // Sentence punctuation first, so a wrapper inside it is still found:
    // "(https://example.com/x)." peels the period, then the bracket.
    const kept = SENTENCE_PUNCTUATION.exec(body)?.[0].length ?? 0;
    const wrap = WRAPPERS.exec(body.slice(0, body.length - kept))?.[0].length ?? 0;
    if (!unspeakableToken(body.slice(0, body.length - kept - wrap))) continue;

    let start = from;
    let end = from + raw.length - kept;
    if (kept === 0) {
      // Take the space after it too, so the sentence closes up cleanly.
      while (end < text.length && /\s/.test(text[end])) end++;
    } else {
      // Punctuation is staying, so close the space in front of it instead.
      while (start > 0 && /\s/.test(text[start - 1])) start--;
    }
    spans.push({ start, end });
  }
  return spans;
}

function withoutSpans(text: string, spans: WordSpan[]): string {
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start);
    at = span.end;
  }
  return out + text.slice(at);
}

// Whether there is a sentence in here worth saying, once the unsayable tokens
// are out of it.
export function speakable(text: string): boolean {
  const rest = withoutSpans(text, unspeakableSpans(text)).trim();
  if (!LETTER.test(rest)) return false;

  const chars = Array.from(rest).filter((char) => !/\s/.test(char));
  if (chars.length === 0) return false;

  let letters = 0;
  let math = 0;
  for (const char of chars) {
    if (MATH_CHAR.test(char)) math++;
    else if (LETTER.test(char)) letters++;
  }

  // A rendered formula. Counted rather than merely detected, so a sentence
  // that mentions a variable or two survives and a gradient expression does
  // not.
  if (math >= MIN_MATH_CHARS && math / chars.length > MAX_MATH_SHARE) {
    return false;
  }
  if (letters / chars.length < MIN_LETTER_SHARE) return false;

  // One enormous unbroken run is an object — an encoded blob, a formula with
  // its spaces stripped — whatever its characters happen to be.
  const longest = (rest.match(/\S+/g) ?? []).reduce(
    (most, token) => Math.max(most, token.length),
    0
  );
  if (longest >= MIN_BLOB_CHARS && longest / chars.length > MAX_BLOB_SHARE) {
    return false;
  }

  // And something in it has to be pronounceable.
  const words = rest.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  return words.some((word) => word.length <= 3 || VOWEL.test(word));
}
