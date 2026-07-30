"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { deleteEntry, listEntries, purgeTombstones, putEntry } from "@/lib/db";
import {
  createEntry,
  isToday,
  randomPlaceholder,
  WELCOME_CONTENT,
} from "@/lib/entries";
import { DEFAULT_FONT_ID, DEFAULT_FONT_SIZE } from "@/lib/fonts";
import { clearShareRecord, getShareRecord } from "@/lib/shares";
import { adoptSketches, pruneSketches, putSketch } from "@/lib/sketch";
import type { Entry, Sketch } from "@/lib/types";

// Preview cycles rather than toggles: writing only, writing beside the
// rendered text, then the rendered text on its own.
export type PreviewMode = "off" | "split" | "full";

const PREVIEW_CYCLE: Record<PreviewMode, PreviewMode> = {
  off: "split",
  split: "full",
  full: "off",
};

interface PrefsState {
  fontId: string;
  fontSize: number;
  backspaceDisabled: boolean;
  previewMode: PreviewMode;
  setFont: (fontId: string) => void;
  setFontSize: (size: number) => void;
  toggleBackspace: () => void;
  cyclePreview: () => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      fontId: DEFAULT_FONT_ID,
      fontSize: DEFAULT_FONT_SIZE,
      backspaceDisabled: false,
      previewMode: "off",
      setFont: (fontId) => set({ fontId }),
      setFontSize: (fontSize) => set({ fontSize }),
      toggleBackspace: () =>
        set((s) => ({ backspaceDisabled: !s.backspaceDisabled })),
      cyclePreview: () =>
        set((s) => ({ previewMode: PREVIEW_CYCLE[s.previewMode] })),
    }),
    {
      name: "freewrite:prefs",
      version: 1,
      // v0 stored a markdownPreview boolean; on/off maps onto split/off.
      migrate: (state, version) => {
        if (version >= 1) return state as PrefsState;
        const { markdownPreview, ...rest } = (state ?? {}) as Partial<PrefsState> & {
          markdownPreview?: boolean;
        };
        return {
          ...rest,
          previewMode: markdownPreview ? "split" : "off",
        } as PrefsState;
      },
    }
  )
);

const DEFAULT_DURATION = 15 * 60_000;
const MAX_DURATION = 45 * 60_000;
const SCROLL_STEP = 5 * 60_000;

interface TimerState {
  durationMs: number;
  remainingMs: number;
  running: boolean;
  endsAt: number | null;
  toggle: () => void;
  reset: () => void;
  adjust: (direction: 1 | -1) => void;
  tick: () => void;
}

export const useTimer = create<TimerState>()((set, get) => ({
  durationMs: DEFAULT_DURATION,
  remainingMs: DEFAULT_DURATION,
  running: false,
  endsAt: null,

  toggle: () => {
    const s = get();
    if (s.running) {
      set({
        running: false,
        endsAt: null,
        remainingMs: Math.max(0, (s.endsAt ?? 0) - Date.now()),
      });
    } else {
      const base = s.remainingMs > 0 ? s.remainingMs : s.durationMs;
      set({ running: true, endsAt: Date.now() + base, remainingMs: base });
    }
  },

  reset: () =>
    set({
      running: false,
      endsAt: null,
      durationMs: DEFAULT_DURATION,
      remainingMs: DEFAULT_DURATION,
    }),

  adjust: (direction) => {
    const s = get();
    const current = s.running ? Math.max(0, (s.endsAt ?? 0) - Date.now()) : s.remainingMs;
    const next = Math.min(
      MAX_DURATION,
      Math.max(0, current + direction * SCROLL_STEP)
    );
    set({
      remainingMs: next,
      endsAt: s.running ? Date.now() + next : null,
      durationMs: next > 0 ? next : s.durationMs,
    });
  },

  tick: () => {
    const s = get();
    if (!s.running || s.endsAt === null) return;
    const remaining = Math.max(0, s.endsAt - Date.now());
    if (remaining === 0) {
      set({ running: false, endsAt: null, remainingMs: s.durationMs });
    } else {
      set({ remainingMs: remaining });
    }
  },
}));

export type SaveState = "idle" | "saving" | "saved" | "error";

interface WriterState {
  entries: Entry[];
  currentId: string | null;
  placeholder: string;
  ready: boolean;
  sidebarOpen: boolean;
  saveState: SaveState;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  setContent: (content: string) => void;
  setSketch: (sketch: Sketch) => void;
  dropSketch: (id: string) => void;
  addEntry: () => void;
  select: (id: string) => void;
  remove: (id: string) => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  flush: () => void;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Entry | null = null;

// Which entry was open last, so a reload resumes where the writer left off
// instead of minting a fresh entry every visit.
const LAST_ENTRY_KEY = "freewrite:last-entry";

function rememberEntry(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_ENTRY_KEY, id);
    else localStorage.removeItem(LAST_ENTRY_KEY);
  } catch {
    // Storage can be unavailable (private mode) — resuming is best-effort.
  }
}

function lastEntryId(): string | null {
  try {
    return localStorage.getItem(LAST_ENTRY_KEY);
  } catch {
    return null;
  }
}

let savedTimeout: ReturnType<typeof setTimeout> | null = null;

// "Saved" is a reassurance, not a status bar — it shows briefly and then the
// indicator goes quiet again. A newer edit always wins over a stale timer.
function settleSaveState(next: SaveState) {
  if (savedTimeout) clearTimeout(savedTimeout);
  useWriter.setState({ saveState: next });
  if (next !== "saved") return;
  savedTimeout = setTimeout(() => {
    if (useWriter.getState().saveState === "saved") {
      useWriter.setState({ saveState: "idle" });
    }
  }, 1600);
}

function flushPending() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (pendingSave) {
    void putEntry(pendingSave).then(
      () => settleSaveState("saved"),
      () => settleSaveState("error")
    );
    pendingSave = null;
  }
}

// Every edit to the open entry goes through here: it stamps updatedAt, lights
// the save indicator and (re)arms the debounced write, so text and drawings are
// saved by exactly the same machinery.
function editCurrent(edit: (entry: Entry) => Entry) {
  const { entries, currentId } = useWriter.getState();
  if (!currentId) return;
  const updated = entries.map((e) =>
    e.id === currentId ? { ...edit(e), updatedAt: Date.now() } : e
  );
  useWriter.setState({ entries: updated, saveState: "saving" });
  if (savedTimeout) clearTimeout(savedTimeout);

  pendingSave = updated.find((e) => e.id === currentId) ?? null;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(flushPending, 400);
}

// Every drawing on every other entry, lazily — adoptSketches stops reading as
// soon as it has what the text asked for, so a paste doesn't walk the history.
function* sketchesElsewhere(currentId: string): Generator<Sketch> {
  for (const entry of useWriter.getState().entries) {
    if (entry.id === currentId) continue;
    for (const sketch of entry.sketches ?? []) yield sketch;
  }
}

// A reference the entry doesn't have a drawing for, when another entry does:
// somebody pasted it, so take a copy. Also catches the reference that arrived
// before its drawing did — a paste on one device, opened on another.
function adoptCurrent() {
  const { entries, currentId } = useWriter.getState();
  const entry = entries.find((e) => e.id === currentId);
  if (!entry) return;
  const adopted = adoptSketches(
    entry.content,
    entry.sketches,
    sketchesElsewhere(entry.id)
  );
  if (adopted !== entry.sketches) editCurrent((e) => ({ ...e, sketches: adopted }));
}

// Drawings the text no longer points at go when the writer leaves the entry,
// rather than the moment the reference disappears: cutting one to paste it
// further down is an ordinary edit, and it mustn't take the drawing with it.
function pruneCurrent() {
  const { entries, currentId } = useWriter.getState();
  const entry = entries.find((e) => e.id === currentId);
  if (!entry?.sketches?.length) return;
  const kept = pruneSketches(entry.content, entry.sketches);
  if (kept !== entry.sketches) editCurrent((e) => ({ ...e, sketches: kept }));
}

export const useWriter = create<WriterState>()((set, get) => ({
  entries: [],
  currentId: null,
  placeholder: "Begin writing",
  ready: false,
  sidebarOpen: false,
  saveState: "idle",

  init: async () => {
    const all = await listEntries();
    const stale = all.filter(
      (e) => !e.content.trim() && !isToday(e.createdAt)
    );
    await Promise.all(stale.map((e) => deleteEntry(e.id)));
    const entries = all.filter((e) => !stale.includes(e));

    let currentId: string | null;
    if (entries.length === 0) {
      const welcome = createEntry(WELCOME_CONTENT);
      await putEntry(welcome);
      entries.push(welcome);
      currentId = welcome.id;
    } else {
      // Resume whatever was open last; fall back to the newest entry. New
      // entries only come from the New Entry button, never from a reload.
      const last = lastEntryId();
      currentId = entries.some((e) => e.id === last)
        ? last
        : entries[0].id;
    }

    rememberEntry(currentId);
    set({ entries, currentId, placeholder: randomPlaceholder(), ready: true });
    void purgeTombstones();
  },

  reload: async () => {
    const state = get();
    if (!state.ready) return;
    const fromDb = await listEntries();
    const entries = fromDb.map((e) => {
      const inState = state.entries.find((s) => s.id === e.id);
      return inState && inState.updatedAt > e.updatedAt ? inState : e;
    });

    let { currentId } = state;
    if (currentId && !entries.some((e) => e.id === currentId)) {
      if (entries.length === 0) {
        const fresh = createEntry();
        void putEntry(fresh);
        entries.push(fresh);
        currentId = fresh.id;
      } else {
        currentId = entries[0].id;
      }
      rememberEntry(currentId);
    }
    set({ entries, currentId });
  },

  setContent: (content) => {
    const { currentId } = get();
    editCurrent((e) => ({
      ...e,
      content,
      // A pasted reference brings its drawing along, in the same edit that
      // pasted it — so the figure is there rather than appearing a beat later.
      sketches: adoptSketches(
        content,
        e.sketches,
        sketchesElsewhere(currentId ?? "")
      ),
    }));
  },

  // Every finished stroke lands here, so a drawing saves the way typing does
  // and there is no Done button to forget to press.
  setSketch: (sketch) => {
    editCurrent((e) => ({ ...e, sketches: putSketch(e.sketches, sketch) }));
  },

  // A drawing closed without a mark on it. Its reference goes with it, back in
  // the editor — nothing is left behind by opening the board and changing your
  // mind.
  dropSketch: (id) => {
    editCurrent((e) => {
      const kept = e.sketches?.filter((s) => s.id !== id);
      return { ...e, sketches: kept?.length ? kept : undefined };
    });
  },

  addEntry: () => {
    pruneCurrent();
    flushPending();
    const fresh = createEntry();
    void putEntry(fresh);
    rememberEntry(fresh.id);
    set((s) => ({
      entries: [fresh, ...s.entries],
      currentId: fresh.id,
      placeholder: randomPlaceholder(),
      sidebarOpen: false,
    }));
  },

  select: (id) => {
    pruneCurrent();
    flushPending();
    rememberEntry(id);
    set({ currentId: id });
    adoptCurrent();
  },

  remove: async (id) => {
    if (pendingSave?.id === id) {
      pendingSave = null;
      if (saveTimeout) clearTimeout(saveTimeout);
    }
    // Deleting an entry unpublishes it too — best effort; worst case the
    // public snapshot just lives out its TTL.
    const share = getShareRecord(id);
    if (share) {
      void fetch(`/api/share/entry/${share.id}`, {
        method: "DELETE",
        headers: { "x-share-token": share.token },
      }).catch(() => {});
      clearShareRecord(id);
    }
    await deleteEntry(id);
    const entries = get().entries.filter((e) => e.id !== id);

    let { currentId } = get();
    if (currentId === id) {
      if (entries.length > 0) {
        currentId = entries[0].id;
      } else {
        const fresh = createEntry();
        void putEntry(fresh);
        entries.push(fresh);
        currentId = fresh.id;
      }
      rememberEntry(currentId);
    }
    set({ entries, currentId });
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  flush: flushPending,
}));

export function currentEntry(state: WriterState): Entry | null {
  return state.entries.find((e) => e.id === state.currentId) ?? null;
}
