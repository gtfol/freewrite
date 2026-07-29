"use client";

import { Highlighter, MessageCircle } from "lucide-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  anchorFromRange,
  applyHighlights,
  clearHighlights,
  type QuoteAnchor,
} from "@/lib/highlights";
import type { Article, Highlight } from "@/lib/types";

// Matches the server-side sync caps (which allow slack above these).
const MAX_HIGHLIGHTS = 500;
const MAX_NOTE_CHARS = 4_000;

const CARD_WIDTH = 288;

// The pill as rendered, and the gap it keeps from the selection.
const PILL_HEIGHT = 40;
const PILL_GAP = 8;
// How close to the top of the screen a selection has to be before the phone
// gives up on putting its own menu above it: the bar measures ~44 tall sitting
// ~19 clear of the selection, so under about that much room it flips below.
// Anything higher than the phone's real threshold is a band where both it and
// the pill choose "above" — which is the collision this is here to avoid.
const NATIVE_MENU = 72;
// The reader nav is fixed to the bottom of the screen and would sit on top of
// a pill placed under a selection near the fold.
const NAV_HEIGHT = 96;

// Which side of the selection the pill goes on. Phones draw the system's
// Copy / Look Up bar directly over the space above a selection — where this
// pill used to be — so on touch the pill goes below instead.
//
// Both iOS and Android flip that bar below the selection when the selection is
// near the top of the screen and there's no room above it. The pill flips with
// it: whichever side the phone took, ours takes the other.
type Place = "above" | "below";

// Viewport coordinates: the side, and the y the pill is positioned at — its
// bottom edge above a selection, its top edge below one.
//
// The side is the phone's to decide, so it is never traded away for room. A
// selection near the fold has nowhere under it to put the pill; the pill slides
// up over the last line of the selection rather than flipping to the side the
// system bar has taken, where it would come out unreachable underneath it.
function placeFor(rect: DOMRect): { place: Place; y: number } {
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  // A mouse gets no system menu to dodge, and above the selection is where a
  // Medium-style pill belongs.
  if (!coarse || rect.top < NATIVE_MENU) {
    // Clamped so a selection starting at the top of the screen doesn't push the
    // pill off it.
    return {
      place: "above",
      y: Math.max(rect.top - PILL_GAP, PILL_GAP + PILL_HEIGHT),
    };
  }
  const floor = window.innerHeight - NAV_HEIGHT - PILL_HEIGHT;
  // Sliding up stops at the selection's own top edge: past that is the system
  // bar's space again. A selection in the last sliver above the nav puts the
  // pill over the nav instead, which it outranks and stays tappable through.
  const y = Math.min(rect.bottom + PILL_GAP, floor);
  return { place: "below", y: Math.max(y, rect.top) };
}

// Measured when a panel opens — render must not touch refs, so the wrapper
// width travels with the position.
interface Pos {
  x: number;
  // Where the pill goes, per placeFor; the card hangs off the selection itself.
  y: number;
  bottom: number;
  width: number;
  place: Place;
}

type Panel =
  | { kind: "select"; pos: Pos; anchor: QuoteAnchor }
  | { kind: "actions"; pos: Pos; id: string }
  | { kind: "note"; pos: Pos; id: string }
  | {
      kind: "compose";
      pos: Pos;
      id: string | null;
      anchor: QuoteAnchor | null;
      draft: string;
    };

function relativeTo(wrap: HTMLElement, rect: DOMRect): Pos {
  const w = wrap.getBoundingClientRect();
  // Decided here, against the viewport, while the rect is still in viewport
  // coordinates — Pos itself is relative to the wrapper.
  const { place, y } = placeFor(rect);
  return {
    x: rect.left + rect.width / 2 - w.left,
    y: y - w.top,
    bottom: rect.bottom - w.top,
    width: w.width,
    place,
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

const pillButton =
  "rounded-full p-2 transition-opacity hover:opacity-70 focus-visible:outline-none";

const cardAction =
  "text-muted-foreground transition-colors hover:text-foreground";

// Medium-style annotations over the rendered article: select text for a
// highlight/comment pill, click a highlight to manage it. Marks are painted
// into the content DOM (dangerouslySetInnerHTML children survive re-renders);
// this component owns nothing but the floating panels.
export function HighlightLayer({
  article,
  contentRef,
  wrapRef,
  onSave,
}: {
  article: Article;
  contentRef: RefObject<HTMLDivElement | null>;
  wrapRef: RefObject<HTMLDivElement | null>;
  onSave: (highlights: Highlight[]) => void;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  // The highlight a confirmation dialog is open for. Held apart from the panel
  // so the card it was opened from stays put underneath and comes back on
  // Cancel, instead of the dialog riding on a panel that dismisses itself.
  const [confirming, setConfirming] = useState<string | null>(null);
  const highlights = article.highlights ?? [];

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    applyHighlights(root, article.highlights ?? []);
    return () => clearHighlights(root);
  }, [contentRef, article.content, article.highlights]);

  // The selection pill follows the native selection; anything that collapses
  // it (including clicking elsewhere) dismisses the pill.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const root = contentRef.current;
        const wrap = wrapRef.current;
        const sel = document.getSelection();
        const dismiss = () =>
          setPanel((p) => (p?.kind === "select" ? null : p));
        if (!root || !wrap || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
          return dismiss();
        }
        const range = sel.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return dismiss();
        const anchor = anchorFromRange(root, range);
        if (!anchor) return dismiss();
        setPanel({
          kind: "select",
          pos: relativeTo(wrap, range.getBoundingClientRect()),
          anchor,
        });
      }, 150);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [contentRef, wrapRef]);

  useEffect(() => {
    const root = contentRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest("a")) return; // links inside highlights keep working
      const chip = target.closest("[data-hl-chip]") as HTMLElement | null;
      const mark = chip
        ? null
        : (target.closest("mark[data-hl]") as HTMLElement | null);
      const id = chip?.dataset.hlChip ?? mark?.dataset.hl;
      if (!id) return;
      const hl = (article.highlights ?? []).find((h) => h.id === id);
      if (!hl) return;
      e.preventDefault();
      const pos = relativeTo(wrap, (chip ?? mark)!.getBoundingClientRect());
      setPanel(
        hl.note ? { kind: "note", pos, id } : { kind: "actions", pos, id }
      );
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [contentRef, wrapRef, article.highlights]);

  useEffect(() => {
    // A dialog owns the screen while it's up: its own taps and its Escape are
    // not the outside click that dismisses a panel.
    if (!panel || confirming) return;
    const onDown = (e: Event) => {
      const t = e.target as Element;
      if (t.closest?.("[data-hl-ui], mark[data-hl], [data-hl-chip]")) return;
      setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      // An Escape a dialog already took is marked: it dismisses from a
      // capture-phase listener and prevents the default, and closing itself is
      // the whole of what it was asked to do. Detaching on `confirming` isn't
      // enough on its own — that same Escape re-attaches this listener before
      // the bubble phase reaches the document.
      if (e.key === "Escape" && !e.defaultPrevented) setPanel(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel, confirming]);

  const commit = (next: Highlight[]) => {
    setPanel(null);
    setConfirming(null);
    onSave(next);
  };

  const addHighlight = (anchor: QuoteAnchor, note: string | null) => {
    if (highlights.length >= MAX_HIGHLIGHTS) return;
    const now = Date.now();
    commit([
      ...highlights,
      { id: crypto.randomUUID(), ...anchor, note, createdAt: now, updatedAt: now },
    ]);
    document.getSelection()?.removeAllRanges();
  };

  const removeHighlight = (id: string) =>
    commit(highlights.filter((h) => h.id !== id));

  const saveNote = (id: string, note: string | null) =>
    commit(
      highlights.map((h) =>
        h.id === id ? { ...h, note, updatedAt: Date.now() } : h
      )
    );

  const saveCompose = () => {
    if (panel?.kind !== "compose") return;
    const note = panel.draft.trim() || null;
    if (panel.id) saveNote(panel.id, note);
    else if (panel.anchor && note) addHighlight(panel.anchor, note);
    else setPanel(null);
  };

  // Everything floating over the article, built rather than returned: the
  // dialog below outlives any one panel and has to render beside it.
  let body: ReactNode = null;
  if (panel) {
    const { width } = panel.pos;

    const above = panel.pos.place === "above";

    const pill = (children: ReactNode) => (
      <div
        data-hl-ui
        onMouseDown={(e) => e.preventDefault()}
        className={`absolute z-50 -translate-x-1/2 ${above ? "-translate-y-full" : ""}`}
        style={{
          left: clamp(panel.pos.x, 56, width - 56),
          top: panel.pos.y,
        }}
      >
        <div className="flex items-center rounded-full bg-foreground px-1 py-0.5 text-background shadow-lg">
          {children}
        </div>
      </div>
    );

    const card = (children: ReactNode) => (
      <div
        data-hl-ui
        className="absolute z-50 rounded-lg border border-border bg-popover p-3 font-sans text-popover-foreground shadow-lg"
        style={{
          width: CARD_WIDTH,
          left: clamp(panel.pos.x - CARD_WIDTH / 2, 0, width - CARD_WIDTH),
          top: panel.pos.bottom + 8,
        }}
      >
        {children}
      </div>
    );

    if (panel.kind === "select") {
      body = pill(
        <>
          <button
            type="button"
            className={pillButton}
            title="Highlight"
            aria-label="Highlight"
            onClick={() => addHighlight(panel.anchor, null)}
          >
            <Highlighter className="size-4" />
          </button>
          <button
            type="button"
            className={pillButton}
            title="Comment"
            aria-label="Comment"
            onClick={() =>
              setPanel({
                kind: "compose",
                pos: panel.pos,
                id: null,
                anchor: panel.anchor,
                draft: "",
              })
            }
          >
            <MessageCircle className="size-4" />
          </button>
        </>
      );
    }

    if (panel.kind === "actions") {
      body = pill(
        <>
          <button
            type="button"
            className={pillButton}
            title="Remove highlight"
            aria-label="Remove highlight"
            onClick={() => removeHighlight(panel.id)}
          >
            <Highlighter className="size-4" />
          </button>
          <button
            type="button"
            className={pillButton}
            title="Comment"
            aria-label="Comment"
            onClick={() =>
              setPanel({
                kind: "compose",
                pos: panel.pos,
                id: panel.id,
                anchor: null,
                draft: "",
              })
            }
          >
            <MessageCircle className="size-4" />
          </button>
        </>
      );
    }

    if (panel.kind === "compose") {
      body = card(
        <>
          <textarea
            autoFocus
            value={panel.draft}
            maxLength={MAX_NOTE_CHARS}
            onChange={(e) => setPanel({ ...panel, draft: e.target.value })}
            placeholder="Add a comment…"
            rows={3}
            className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <div className="mt-2 flex items-center justify-end gap-4 text-[13px]">
            <button
              type="button"
              className={cardAction}
              onClick={() => setPanel(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!panel.draft.trim() && !panel.id}
              className="text-foreground transition-opacity hover:opacity-70 disabled:opacity-40"
              onClick={saveCompose}
            >
              Save
            </button>
          </div>
        </>
      );
    }

    // A note whose highlight lost its anchor renders nothing at all.
    const noteId = panel.kind === "note" ? panel.id : null;
    const hl = noteId ? highlights.find((h) => h.id === noteId) : undefined;
    if (noteId && hl?.note) {
      body = card(
        <>
          <p className="text-sm whitespace-pre-wrap">{hl.note}</p>
          <div className="mt-3 flex items-center gap-4 text-xs">
            <button
              type="button"
              className={cardAction}
              onClick={() =>
                setPanel({
                  kind: "compose",
                  pos: panel.pos,
                  id: noteId,
                  anchor: null,
                  draft: hl.note ?? "",
                })
              }
            >
              Edit
            </button>
            <button
              type="button"
              className={cardAction}
              onClick={() => saveNote(noteId, null)}
            >
              Delete comment
            </button>
            {/* What it takes is the dialog's to say, not the row's. */}
            <button
              type="button"
              className={cardAction}
              onClick={() => setConfirming(noteId)}
            >
              Remove highlight
            </button>
          </div>
        </>
      );
    }
  }

  // Only a comment gets a dialog. Removing a bare highlight destroys a colour
  // and is one tap to redo; removing a commented one destroys writing, here
  // and on every synced device, with nothing that can bring it back.
  const doomed = highlights.find((h) => h.id === confirming);
  const quoted =
    doomed?.note && doomed.note.length > 120
      ? `${doomed.note.slice(0, 120).trimEnd()}…`
      : doomed?.note;
  // Built as one string rather than assembled in JSX, where the line break
  // either side of an interpolation eats the spaces around it.
  const consequence = `Its comment${
    quoted ? ` — “${quoted}” — ` : " "
  }goes with it, on this device and every synced one. This can’t be undone.`;

  return (
    <>
      {body}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this highlight?</AlertDialogTitle>
            <AlertDialogDescription>{consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && removeHighlight(confirming)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
