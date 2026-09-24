"use client";

import { create } from "zustand";

import { authClient } from "@/lib/auth-client";
import type { Day, SongOfDayResponse } from "@/lib/spotify";

// Whether this account has Spotify attached, and one entry's song once asked
// for. Deliberately thin: the token lives on the server, so all the browser
// holds is "connected or not" and a track it can already see in its own prose.

// The menu is opened far more often than the day's listening changes, and each
// resolve is a call to Spotify. Two minutes is long enough to make reopening
// free and short enough that a song put on after breakfast still shows up.
const FRESH_MS = 2 * 60_000;

interface SpotifyState {
  // null until we've had a chance to look.
  linked: boolean | null;
  // The answer for whichever day was last asked about. Cleared the moment a
  // different day is asked about, so it is never read as another entry's song.
  song: SongOfDayResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  loadSong: (day: Day, force?: boolean) => Promise<void>;
  forget: () => void;
}

// Which day the song in state is for, when it arrived, which day is being
// asked about now, and a counter so a slow answer for a day the writer has
// already moved on from can't overwrite a newer one.
let fetchedFor = 0;
let fetchedAt = 0;
let fetchingFor = 0;
let requests = 0;

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

  loadSong: async (day, force = false) => {
    const fresh =
      get().song !== null &&
      fetchedFor === day.start &&
      Date.now() - fetchedAt < FRESH_MS;
    if (!force && fresh) return;
    // Already on its way. Only for the same day, though — switching entries
    // has to be able to overtake a request for the day just left.
    if (get().loading && fetchingFor === day.start && !force) return;

    // Whatever is in state answers a different day's question, and would
    // otherwise sit under the menu as if it were this entry's song.
    if (fetchedFor !== day.start) set({ song: null });

    const seq = ++requests;
    fetchingFor = day.start;
    set({ loading: true });
    try {
      const res = await fetch(
        `/api/spotify/song?since=${day.start}&until=${day.end}`
      );
      const song: SongOfDayResponse = await res.json();
      // A newer day is already being asked about; this answer is about an
      // entry the writer has left, and leaving `loading` set is correct.
      if (seq !== requests) return;
      fetchedAt = Date.now();
      fetchedFor = day.start;
      set({ song, loading: false });
      // Every one of these means Spotify answered us, whatever it said about
      // the day itself.
      const answered =
        song.state === "ok" ||
        song.state === "empty" ||
        song.state === "out-of-reach";
      // The route is the authority on whether the link still works, so a
      // stale "connected" gets corrected here rather than lingering.
      if (song.state === "unlinked") set({ linked: false });
      else if (answered) set({ linked: true });
    } catch {
      if (seq !== requests) return;
      set({
        song: { state: "error", message: "Couldn't reach the server" },
        loading: false,
      });
    }
  },

  forget: () => {
    fetchedAt = 0;
    fetchedFor = 0;
    fetchingFor = 0;
    // Nothing in flight belongs to the account that just went away.
    requests += 1;
    set({ song: null, loading: false });
  },
}));
