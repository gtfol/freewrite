// Turning a stored sketch back into a picture. Split from lib/sketch.ts
// because this is the half that needs drawesome's serializer at runtime, and
// the sync and share routes want the pure half without it.

import { toSvg } from "drawesome";

import { sketchRef } from "@/lib/sketch";
import type { Sketch } from "@/lib/types";

// Drawesome names its erase masks e0, e1… counting from zero in each drawing.
// SVG ids are document-global, so two sketches with erased strokes in one entry
// would share them and the second would wear the first's mask. Namespacing by
// sketch id keeps each drawing's erasing its own.
function isolateMasks(svg: string, id: string): string {
  return svg
    .replace(/id="e(\d+)"/g, `id="${id}-e$1"`)
    .replace(/url\(#e(\d+)\)/g, `url(#${id}-e$1)`);
}

export function sketchSvg(sketch: Sketch): string {
  return isolateMasks(
    toSvg(sketch.strokes, sketch.w, sketch.h, sketch.bg),
    sketch.id
  );
}

// The serialized SVG is markup, numbers and hex colours and nothing else — no
// writer-supplied text reaches it — so it is ASCII by construction and base64
// is safe without a UTF-8 dance.
export function sketchDataUri(sketch: Sketch): string {
  return `data:image/svg+xml;base64,${btoa(sketchSvg(sketch))}`;
}

// A downloaded entry is one markdown file with nowhere to keep a stroke list,
// so each reference becomes the picture itself. The file stops being editable
// as a drawing and starts being readable in anything that renders markdown,
// which is the better trade for something you asked to take away with you.
export function embedSketches(
  content: string,
  sketches: Sketch[] | undefined
): string {
  if (!sketches?.length) return content;
  return sketches.reduce(
    (text, sketch) =>
      text.split(sketchRef(sketch.id)).join(`![sketch](${sketchDataUri(sketch)})`),
    content
  );
}
