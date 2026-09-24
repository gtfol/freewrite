"use client";

import { useEffect, useState } from "react";
import { Cloud, CloudOff } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { useSpotify } from "@/lib/spotify-connect";
import { useSync } from "@/lib/sync";
import { cn } from "@/lib/utils";

const optionClass =
  "w-full rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent";

function lastSyncedLabel(lastSyncAt: number | null): string {
  if (!lastSyncAt) return "not synced yet";
  const minutes = Math.floor((Date.now() - lastSyncAt) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes}m ago`;
  return `synced ${Math.floor(minutes / 60)}h ago`;
}

function EmailForm() {
  const refreshSession = useSync((s) => s.refreshSession);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result =
      mode === "sign-up"
        ? await authClient.signUp.email({
            email,
            password,
            name: email.split("@")[0] || "writer",
          })
        : await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong");
    } else {
      await refreshSession();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="email"
        className="h-8 text-sm"
      />
      <Input
        type="password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="password"
        className="h-8 text-sm"
      />
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-between px-1">
        <button
          type="submit"
          disabled={pending}
          className="text-sm text-foreground transition-colors hover:opacity-70 disabled:opacity-40"
        >
          {pending ? "…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {mode === "sign-up" ? "have an account?" : "new here?"}
        </button>
      </div>
    </form>
  );
}

function SignInOptions() {
  const providers = useSync((s) => s.providers);

  const signIn = () => {
    void authClient.signIn.social({
      provider: "google",
      callbackURL: window.location.href,
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 text-xs text-muted-foreground">
        Sync is optional. Without it, everything stays in this browser.
      </p>
      {providers.google && (
        <button className={optionClass} onClick={signIn}>
          Continue with Google
        </button>
      )}
      {providers.email && <EmailForm />}
      {!providers.google && !providers.email && (
        <p className="px-1 text-xs text-muted-foreground">
          No sign-in methods are configured on this deployment.
        </p>
      )}
    </div>
  );
}

// Spotify hangs off an account rather than being a way into one, so it lives
// here under the email you signed in with — not among the sign-in options.
function SpotifyAccount() {
  const linked = useSpotify((s) => s.linked);
  const refresh = useSpotify((s) => s.refresh);
  const connect = useSpotify((s) => s.connect);
  const disconnect = useSpotify((s) => s.disconnect);

  useEffect(() => {
    if (linked === null) void refresh();
  }, [linked, refresh]);

  return (
    <>
      <div className="my-1 h-px bg-border" />
      {linked ? (
        <>
          <button className={optionClass} onClick={() => void disconnect()}>
            Disconnect Spotify
          </button>
          <p className="px-1 text-xs text-muted-foreground">
            Type / in an entry to drop in the day&apos;s song.
          </p>
        </>
      ) : (
        <>
          <button className={optionClass} onClick={() => void connect()}>
            Connect Spotify
          </button>
          <p className="px-1 text-xs text-muted-foreground">
            Reads what you played recently, nothing else, so / can add an
            entry&apos;s song for the day it was written.
          </p>
        </>
      )}
    </>
  );
}

export function SyncPopover() {
  const status = useSync((s) => s.status);
  const user = useSync((s) => s.user);
  const providers = useSync((s) => s.providers);
  const lastSyncAt = useSync((s) => s.lastSyncAt);
  const error = useSync((s) => s.error);
  const init = useSync((s) => s.init);
  const syncNow = useSync((s) => s.syncNow);
  const signOut = useSync((s) => s.signOut);

  useEffect(() => {
    void init();
  }, [init]);

  if (status === "loading" || status === "disabled") return null;

  return (
    <Popover>
      <PopoverTrigger
        title={user ? `Sync — ${user.email}` : "Sync"}
        className={cn(
          "flex items-center transition-colors hover:text-foreground",
          status === "error" ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {user ? (
          <Cloud
            className={cn("size-4", status === "syncing" && "animate-pulse")}
          />
        ) : (
          <CloudOff className="size-4" />
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 p-3">
        {user ? (
          <div className="flex flex-col gap-1">
            <p className="px-1 text-sm text-foreground">{user.email}</p>
            <p className="px-1 text-xs text-muted-foreground">
              {status === "syncing" ? "syncing…" : lastSyncedLabel(lastSyncAt)}
              {status === "error" && error ? ` — ${error}` : ""}
            </p>
            <button className={optionClass} onClick={() => void syncNow()}>
              Sync now
            </button>
            <button className={optionClass} onClick={() => void signOut()}>
              Sign out
            </button>
            <p className="px-1 text-xs text-muted-foreground">
              Signing out keeps your writing on this device.
            </p>
            {providers.spotify && <SpotifyAccount />}
          </div>
        ) : (
          <SignInOptions />
        )}
      </PopoverContent>
    </Popover>
  );
}
