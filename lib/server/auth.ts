import { betterAuth, type BetterAuthOptions } from "better-auth";

import { dbConfigured, getPool } from "@/lib/server/db";
import { RECENTLY_PLAYED_SCOPE } from "@/lib/spotify";

let instance: ReturnType<typeof betterAuth> | null = null;

export function authConfigured(): boolean {
  return dbConfigured() && Boolean(process.env.BETTER_AUTH_SECRET);
}

export function enabledProviders() {
  return {
    google: Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ),
    // Escape hatch for local dev without OAuth credentials.
    email: Boolean(process.env.EMAIL_PASSWORD_AUTH),
    // Not a way to sign in — a thing you attach to an account you already
    // have, so the writer can pull the day's song into an entry.
    spotify: Boolean(
      process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
    ),
  };
}

export function getAuth() {
  if (!authConfigured()) return null;
  if (!instance) {
    const providers = enabledProviders();
    const options: BetterAuthOptions = {
      database: getPool(),
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL: process.env.BETTER_AUTH_URL,
      emailAndPassword: { enabled: providers.email },
      socialProviders: {
        ...(providers.google && {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          },
        }),
        ...(providers.spotify && {
          spotify: {
            clientId: process.env.SPOTIFY_CLIENT_ID!,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
            // Read the play history and nothing else. On top of this the
            // provider always asks for user-read-email, which is how it
            // identifies the account it just connected.
            scope: [RECENTLY_PLAYED_SCOPE],
            // Spotify can never mint a freewrite account. It only ever
            // attaches to one that already exists.
            disableSignUp: true,
          },
        }),
      },
      account: {
        accountLinking: {
          enabled: true,
          // Spotify's API exposes no email-verification flag, so better-auth
          // reads the profile as unverified and refuses to link it unless the
          // provider is trusted. Trusting it is what makes Connect work at
          // all, and it buys nothing else: signing up through Spotify is off
          // above, and linking already demands a live session.
          trustedProviders: ["spotify"],
          // The email on your Spotify account needn't be the one you signed
          // in with here.
          allowDifferentEmails: true,
        },
      },
    };
    instance = betterAuth(options);
  }
  return instance;
}
