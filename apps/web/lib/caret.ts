"use client";

// Where the caret sits, in pixels, inside a <textarea>.
//
// A textarea exposes no geometry for its own text — no Range, no client rect
// for a character — so the only way to anchor a menu to the caret is to lay
// the same text out again somewhere invisible and measure that instead. Hence
// the long property list: anything that affects where a line wraps has to be
// identical in the mirror or the measurement drifts.

const MIRRORED = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "textAlign",
  "tabSize",
  "direction",
] as const;

let mirror: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
  if (mirror?.isConnected) return mirror;
  mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
    height: "auto",
    // How a textarea wraps its own value.
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  document.body.appendChild(mirror);
  return mirror;
}

export interface CaretPoint {
  // Relative to the textarea's border box, its own scrolling already taken
  // out, so callers can add the element's client rect and be done.
  top: number;
  left: number;
  lineHeight: number;
}

export function caretPoint(
  el: HTMLTextAreaElement,
  index: number
): CaretPoint | null {
  if (!el.clientWidth) return null;

  const div = getMirror();
  const style = window.getComputedStyle(el);
  for (const prop of MIRRORED) div.style[prop] = style[prop];

  // getComputedStyle().width is the content width, but box-sizing decides
  // whether that is what `width` would mean on the mirror. Pinning the mirror
  // to content-box and deriving the content width from clientWidth (which
  // excludes the scrollbar the textarea may be showing) sidesteps the
  // question entirely.
  const padX =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  div.style.boxSizing = "content-box";
  div.style.width = `${Math.max(0, el.clientWidth - padX)}px`;

  div.textContent = el.value.slice(0, index);
  const span = document.createElement("span");
  // The text after the caret goes in the span so it wraps exactly as it does
  // in the textarea; the span's first box is the caret. A caret at the very
  // end has nothing after it, and an empty span has no box to measure.
  span.textContent = el.value.slice(index) || ".";
  div.appendChild(span);

  const lineHeight =
    parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2;
  const point = {
    top: span.offsetTop - el.scrollTop,
    left: span.offsetLeft - el.scrollLeft,
    lineHeight,
  };

  // Long entries mirrored in full would otherwise sit in the DOM until the
  // next measurement.
  div.textContent = "";
  return point;
}
