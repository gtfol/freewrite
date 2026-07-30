"use client";

import { useEffect, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { isWelcomeEntry } from "@/lib/entries";
import { referencedIds } from "@/lib/sketch";
import {
  clearShareRecord,
  expiresLabel,
  getShareRecord,
  setShareRecord,
  shareUrl,
  type ShareRecord,
} from "@/lib/shares";
import { currentEntry, usePrefs, useWriter } from "@/lib/store";

const optionClass =
  "w-full rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent";

const noteClass = "px-3 py-2 text-xs text-muted-foreground";

type Busy = "create" | "update" | "delete" | null;

export function SharePopover() {
  const entry = useWriter(currentEntry);
  const sketches = useWriter((s) => s.sketches);
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);

  const [shareReady, setShareReady] = useState<boolean | null>(null);
  const [ttlSeconds, setTtlSeconds] = useState(30 * 24 * 60 * 60);
  // Per-entry panel state, keyed so switching entries falls back to the
  // stored record instead of leaking the previous entry's link or error.
  const [panel, setPanel] = useState<{
    entryId: string;
    record: ShareRecord | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/share")
      .then((res) => res.json())
      .then((body) => {
        setShareReady(!!body?.enabled);
        if (typeof body?.entryTtlSeconds === "number") {
          setTtlSeconds(body.entryTtlSeconds);
        }
      })
      .catch(() => setShareReady(false));
  }, []);

  if (!entry) return null;

  const active = panel?.entryId === entry.id ? panel : null;
  const record = active ? active.record : getShareRecord(entry.id);
  const error = active?.error ?? null;
  const setPanelState = (
    nextRecord: ShareRecord | null,
    nextError: string | null = null
  ) => setPanel({ entryId: entry.id, record: nextRecord, error: nextError });

  const text = entry.content;
  const isWelcome = isWelcomeEntry(text);
  const isEmpty = !text.trim();
  const stale = record !== null && entry.updatedAt > record.entryUpdatedAt;
  const ttlDays = Math.max(1, Math.round(ttlSeconds / 86_400));
  const referenced = referencedIds(text);

  const snapshotBody = () =>
    JSON.stringify({
      content: entry.content,
      fontId,
      fontSize,
      // Only what this entry's text points at — a share is one entry, not the
      // whole drawer of drawings.
      sketches: sketches.filter((s) => referenced.has(s.id)),
      createdAt: entry.createdAt,
    });

  const failureMessage = (body: unknown): string => {
    const message = (body as { error?: unknown } | null)?.error;
    return typeof message === "string" ? message : "Something went wrong — try again";
  };

  const create = async () => {
    setBusy("create");
    try {
      const res = await fetch("/api/share/entry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: snapshotBody(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(failureMessage(body));
      const now = Date.now();
      const next: ShareRecord = {
        id: body.id,
        token: body.token,
        sharedAt: now,
        expiresAt: now + body.ttlSeconds * 1000,
        entryUpdatedAt: entry.updatedAt,
      };
      setShareRecord(entry.id, next);
      setPanelState(next);
    } catch (e) {
      setPanelState(
        null,
        e instanceof Error ? e.message : "Couldn't create a share link"
      );
    } finally {
      setBusy(null);
    }
  };

  const update = async () => {
    if (!record) return;
    setBusy("update");
    try {
      const res = await fetch(`/api/share/entry/${record.id}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-share-token": record.token,
        },
        body: snapshotBody(),
      });
      const body = await res.json();
      if (res.status === 410) {
        // Expired out from under us — drop the dead record so the next
        // click starts fresh.
        clearShareRecord(entry.id);
        setPanelState(null, "That link had already expired — create a new one");
        return;
      }
      if (!res.ok) throw new Error(failureMessage(body));
      const now = Date.now();
      const next: ShareRecord = {
        ...record,
        sharedAt: now,
        expiresAt: now + body.ttlSeconds * 1000,
        entryUpdatedAt: entry.updatedAt,
      };
      setShareRecord(entry.id, next);
      setPanelState(next);
    } catch (e) {
      setPanelState(
        record,
        e instanceof Error ? e.message : "Couldn't update the link"
      );
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!record) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/share/entry/${record.id}`, {
        method: "DELETE",
        headers: { "x-share-token": record.token },
      });
      if (!res.ok && res.status !== 410) {
        throw new Error(failureMessage(await res.json()));
      }
      clearShareRecord(entry.id);
      setPanelState(null);
    } catch (e) {
      setPanelState(
        record,
        e instanceof Error ? e.message : "Couldn't delete the link"
      );
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!record) return;
    await navigator.clipboard.writeText(shareUrl(record.id));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Popover>
      <PopoverTrigger className="text-muted-foreground transition-colors hover:text-foreground">
        Share
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-72 p-2">
        {shareReady === false ? (
          <p className={noteClass}>
            Sharing isn&apos;t configured on this deployment.
          </p>
        ) : isWelcome ? (
          <p className={noteClass}>
            This is the guide. Write your own entry first, then share it.
          </p>
        ) : isEmpty ? (
          <p className={noteClass}>Write something first, then share it.</p>
        ) : record === null ? (
          <div className="flex flex-col gap-1">
            <p className={noteClass}>
              Publish this entry as a read-only page. Anyone with the link can
              read it, and it expires on its own after {ttlDays} days.
            </p>
            <button
              className={`${optionClass} disabled:opacity-40`}
              onClick={create}
              disabled={busy !== null || shareReady === null}
            >
              {busy === "create" ? "Creating link…" : "Create link"}
            </button>
            {error && <p className={noteClass}>{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="truncate px-3 pt-2 text-xs text-muted-foreground">
              {shareUrl(record.id)}
            </p>
            <button className={optionClass} onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </button>
            {stale && (
              <button
                className={`${optionClass} disabled:opacity-40`}
                onClick={update}
                disabled={busy !== null}
              >
                {busy === "update"
                  ? "Updating…"
                  : "Update link — entry has changed"}
              </button>
            )}
            <button
              className="w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-40"
              onClick={remove}
              disabled={busy !== null}
            >
              {busy === "delete" ? "Deleting…" : "Delete link"}
            </button>
            <div className="my-1 h-px bg-border" />
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              Anyone with the link can read this entry. It expires in{" "}
              {expiresLabel(record.expiresAt)}.
            </p>
            {error && <p className={noteClass}>{error}</p>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
