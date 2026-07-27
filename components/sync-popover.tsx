"use client";

import { useEffect } from "react";
import { Cloud, CloudOff } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { authClient } from "@/lib/auth-client";
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
      {providers.google ? (
        <button className={optionClass} onClick={signIn}>
          Continue with Google
        </button>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          No sign-in methods are configured on this deployment.
        </p>
      )}
    </div>
  );
}

export function SyncPopover() {
  const status = useSync((s) => s.status);
  const user = useSync((s) => s.user);
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
          </div>
        ) : (
          <SignInOptions />
        )}
      </PopoverContent>
    </Popover>
  );
}
