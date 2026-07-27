"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { deleteEntry, listEntries, putEntry } from "@/lib/db";
import {
  createEntry,
  isToday,
  isWelcomeEntry,
  randomPlaceholder,
  WELCOME_CONTENT,
} from "@/lib/entries";
import { DEFAULT_FONT_ID, DEFAULT_FONT_SIZE, nextFontSize } from "@/lib/fonts";
import type { Entry } from "@/lib/types";

interface PrefsState {
  fontId: string;
  fontSize: number;
  backspaceDisabled: boolean;
  setFont: (fontId: string) => void;
  cycleFontSize: () => void;
  toggleBackspace: () => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      fontId: DEFAULT_FONT_ID,
      fontSize: DEFAULT_FONT_SIZE,
      backspaceDisabled: false,
      setFont: (fontId) => set({ fontId }),
      cycleFontSize: () => set((s) => ({ fontSize: nextFontSize(s.fontSize) })),
      toggleBackspace: () =>
        set((s) => ({ backspaceDisabled: !s.backspaceDisabled })),
    }),
    { name: "freewrite:prefs" }
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

interface WriterState {
  entries: Entry[];
  currentId: string | null;
  placeholder: string;
  ready: boolean;
  sidebarOpen: boolean;
  init: () => Promise<void>;
  setContent: (content: string) => void;
  addEntry: () => void;
  select: (id: string) => void;
  remove: (id: string) => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  flush: () => void;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Entry | null = null;

function flushPending() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (pendingSave) {
    void putEntry(pendingSave);
    pendingSave = null;
  }
}

export const useWriter = create<WriterState>()((set, get) => ({
  entries: [],
  currentId: null,
  placeholder: "Begin writing",
  ready: false,
  sidebarOpen: false,

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
    } else if (entries.length === 1 && isWelcomeEntry(entries[0].content)) {
      currentId = entries[0].id;
    } else {
      const todayEmpty = entries.find(
        (e) => !e.content.trim() && isToday(e.createdAt)
      );
      if (todayEmpty) {
        currentId = todayEmpty.id;
      } else {
        const fresh = createEntry();
        await putEntry(fresh);
        entries.unshift(fresh);
        currentId = fresh.id;
      }
    }

    set({ entries, currentId, placeholder: randomPlaceholder(), ready: true });
  },

  setContent: (content) => {
    const { entries, currentId } = get();
    if (!currentId) return;
    const updated = entries.map((e) =>
      e.id === currentId ? { ...e, content, updatedAt: Date.now() } : e
    );
    set({ entries: updated });

    pendingSave = updated.find((e) => e.id === currentId) ?? null;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(flushPending, 400);
  },

  addEntry: () => {
    flushPending();
    const fresh = createEntry();
    void putEntry(fresh);
    set((s) => ({
      entries: [fresh, ...s.entries],
      currentId: fresh.id,
      placeholder: randomPlaceholder(),
      sidebarOpen: false,
    }));
  },

  select: (id) => {
    flushPending();
    set({ currentId: id });
  },

  remove: async (id) => {
    if (pendingSave?.id === id) {
      pendingSave = null;
      if (saveTimeout) clearTimeout(saveTimeout);
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
    }
    set({ entries, currentId });
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  flush: flushPending,
}));

export function currentEntry(state: WriterState): Entry | null {
  return state.entries.find((e) => e.id === state.currentId) ?? null;
}
