// Scroll only as far as needed to fit the caret's entire line in the usable
// viewport. An already-visible caret must not move the writer's scroll position.
export function caretScrollDelta(
  caretTop: number,
  lineHeight: number,
  visibleTop: number,
  visibleBottom: number
): number {
  const bottom = Math.max(visibleTop + lineHeight, visibleBottom);
  if (caretTop < visibleTop) return caretTop - visibleTop;
  if (caretTop + lineHeight > bottom) return caretTop + lineHeight - bottom;
  return 0;
}
