"use client";

import { create } from "zustand";

import { authClient } from "@/lib/auth-client";
import {
  applyRemoteArticle,
  applyRemoteEntry,
  clearOutboxItem,
  getArticleRaw,
  getEntryRaw,
  listOutbox,
  setOnLocalChange,
} from "@/lib/db";
import { useWriter } from "@/lib/store";
import type { Article, Entry, SyncResponse } from "@/lib/types";

const CURSORS_KEY = "freewrite:sync-cursors";
const PUSH_BATCH = 100;
const DEBOUNCE_MS = 3_000;
const INTERVAL_MS = 60_000;
const MAX_ROUNDS = 20;

export const SYNC_APPLIED_EVENT = "freewrite:sync-applied";

interface Cursors {
  entries: number;
  articles: number;
}

function loadCursors(userId: string): Cursors {
  try {
    const stored = JSON.parse(localStorage.getItem(CURSORS_KEY) ?? "");
    if (stored?.userId === userId) {
      return { entries: stored.entries ?? 0, articles: stored.articles ?? 0 };
    }
  } catch {
    // fresh cursors
  }
  return { entries: 0, articles: 0 };
}

function saveCursors(userId: string, cursors: Cursors) {
  localStorage.setItem(CURSORS_KEY, JSON.stringify({ userId, ...cursors }));
}

export type SyncStatus =
  | "loading"
  | "disabled"
  | "signed-out"
  | "idle"
  | "syncing"
  | "error";

interface SyncUser {
  id: string;
  email: string;
}

interface SyncState {
  status: SyncStatus;
  providers: { google: boolean };
  user: SyncUser | null;
  lastSyncAt: number | null;
  error: string | null;
  init: () => Promise<void>;
  refreshSession: () => Promise<void>;
  syncNow: () => Promise<void>;
  signOut: () => Promise<void>;
}

let started = false;
let inFlight = false;
let queued = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export const useSync = create<SyncState>()((set, get) => ({
  status: "loading",
  providers: { google: false },
  user: null,
  lastSyncAt: null,
  error: null,

  init: async () => {
    if (started) return;
    started = true;

    try {
      const res = await fetch("/api/sync/status");
      const status = await res.json();
      if (!status.enabled) {
        set({ status: "disabled" });
        return;
      }
      set({ providers: status.providers });
    } catch {
      set({ status: "disabled" });
      return;
    }

    setOnLocalChange(() => {
      if (!get().user) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void get().syncNow(), DEBOUNCE_MS);
    });
    window.addEventListener("online", () => void get().syncNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void get().syncNow();
    });
    setInterval(() => {
      if (document.visibilityState === "visible") void get().syncNow();
    }, INTERVAL_MS);

    await get().refreshSession();
  },

  refreshSession: async () => {
    try {
      const { data } = await authClient.getSession();
      if (data?.user) {
        set({
          user: { id: data.user.id, email: data.user.email },
          status: "idle",
          error: null,
        });
        void get().syncNow();
      } else {
        set({ user: null, status: "signed-out" });
      }
    } catch {
      set({ user: null, status: "signed-out" });
    }
  },

  syncNow: async () => {
    const { user, status } = get();
    if (!user || status === "disabled" || !navigator.onLine) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    set({ status: "syncing" });

    try {
      let cursors = loadCursors(user.id);

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const outbox = await listOutbox();
        const entryChanges: Entry[] = [];
        const articleChanges: Article[] = [];
        const snapshot = new Map<string, number>();

        for (const item of outbox) {
          if (item.collection === "entries") {
            if (entryChanges.length >= PUSH_BATCH) continue;
            const record = await getEntryRaw(item.id);
            if (!record) {
              await clearOutboxItem(item.key);
              continue;
            }
            entryChanges.push(record);
            snapshot.set(item.key, record.updatedAt);
          } else {
            if (articleChanges.length >= PUSH_BATCH) continue;
            const record = await getArticleRaw(item.id);
            if (!record) {
              await clearOutboxItem(item.key);
              continue;
            }
            articleChanges.push(record);
            snapshot.set(item.key, record.updatedAt);
          }
        }

        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            entries: { since: cursors.entries, changes: entryChanges },
            articles: { since: cursors.articles, changes: articleChanges },
          }),
        });
        if (res.status === 401) {
          set({ user: null, status: "signed-out" });
          return;
        }
        if (!res.ok) throw new Error(`Sync failed (${res.status})`);
        const data: SyncResponse = await res.json();

        for (const [key, pushedAt] of snapshot) {
          const separator = key.indexOf(":");
          const collection = key.slice(0, separator);
          const id = key.slice(separator + 1);
          const record =
            collection === "entries"
              ? await getEntryRaw(id)
              : await getArticleRaw(id);
          if (record && record.updatedAt === pushedAt) {
            await clearOutboxItem(key);
          }
        }

        let applied = false;
        for (const row of data.entries.rows) {
          const local = await getEntryRaw(row.id);
          if (!local || row.updatedAt > local.updatedAt) {
            await applyRemoteEntry(row);
            applied = true;
          }
        }
        for (const row of data.articles.rows) {
          const local = await getArticleRaw(row.id);
          if (!local || row.updatedAt > local.updatedAt) {
            await applyRemoteArticle(row);
            applied = true;
          }
        }

        cursors = { entries: data.entries.cursor, articles: data.articles.cursor };
        saveCursors(user.id, cursors);

        if (applied) {
          await useWriter.getState().reload();
          window.dispatchEvent(new CustomEvent(SYNC_APPLIED_EVENT));
        }

        const outboxDrained = (await listOutbox()).length === 0;
        if (!data.entries.hasMore && !data.articles.hasMore && outboxDrained) {
          break;
        }
      }

      set({ status: "idle", lastSyncAt: Date.now(), error: null });
    } catch (error) {
      set({
        status: "error",
        error: error instanceof Error ? error.message : "Sync failed",
      });
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void get().syncNow();
      }
    }
  },

  signOut: async () => {
    await authClient.signOut();
    set({ user: null, status: "signed-out", lastSyncAt: null });
  },
}));
