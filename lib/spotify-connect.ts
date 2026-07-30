"use client";

import { create } from "zustand";

import { authClient } from "@/lib/auth-client";
import type { SongOfDayResponse } from "@/lib/spotify";

// Whether this account has Spotify attached, and today's song once asked for.
// Deliberately thin: the token lives on the server, so all the browser holds
// is "connected or not" and a track it can already see in its own prose.

// The menu is opened far more often than the day's listening changes, and each
// resolve is a call to Spotify. Two minutes is long enough to make reopening
// free and short enough that a song put on after breakfast still shows up.
const FRESH_MS = 2 * 60_000;

// The writer's midnight, not the server's.
function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface SpotifyState {
  // null until we've had a chance to look.
  linked: boolean | null;
  song: SongOfDayResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  loadSong: (force?: boolean) => Promise<void>;
  forget: () => void;
}

let fetchedAt = 0;
let fetchedFor = 0;

export const useSpotify = create<SpotifyState>()((set, get) => ({
  linked: null,
  song: null,
  loading: false,

  refresh: async () => {
    try {
      const { data } = await authClient.listAccounts();
      set({
        linked: Boolean(data?.some((a) => a.providerId === "spotify")),
      });
    } catch {
      // Signed out, or the deployment has no auth at all. Either way there's
      // nothing connected.
      set({ linked: false });
    }
  },

  // Redirects to Spotify and comes back to this page. better-auth requires a
  // live session for this, which is what keeps Connect behind signing in.
  connect: async () => {
    await authClient.linkSocial({
      provider: "spotify",
      callbackURL: window.location.href,
      errorCallbackURL: window.location.href,
    });
  },

  disconnect: async () => {
    await authClient.unlinkAccount({ providerId: "spotify" });
    get().forget();
    set({ linked: false });
  },

  loadSong: async (force = false) => {
    const today = dayStart();
    const fresh =
      get().song !== null &&
      fetchedFor === today &&
      Date.now() - fetchedAt < FRESH_MS;
    if (!force && fresh) return;
    if (get().loading) return;

    set({ loading: true });
    try {
      const res = await fetch(`/api/spotify/song?since=${today}`);
      const song: SongOfDayResponse = await res.json();
      fetchedAt = Date.now();
      fetchedFor = today;
      set({ song, loading: false });
      // The route is the authority on whether the link still works, so a
      // stale "connected" gets corrected here rather than lingering.
      if (song.state === "unlinked") set({ linked: false });
      else if (song.state === "ok" || song.state === "empty") set({ linked: true });
    } catch {
      set({
        song: { state: "error", message: "Couldn't reach the server" },
        loading: false,
      });
    }
  },

  forget: () => {
    fetchedAt = 0;
    fetchedFor = 0;
    set({ song: null });
  },
}));
