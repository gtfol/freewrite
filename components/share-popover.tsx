"use client";

import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isWelcomeEntry } from "@/lib/entries";
import { DEFAULT_ENTRY_SHARE_EXPIRY, type EntryShareExpiry } from "@/lib/share-expiry";
import { referencedIds } from "@/lib/sketch";
import {
  assertShareStorage,
  beginEntryShareMutation,
  clearShareRecord,
  expiresLabel,
  getShareRecord,
  hasPendingShareRecords,
  prepareShareRecord,
  revokeEntryShare,
  setShareRecord,
  shareRecordIsSaved,
  shareUrl,
  withShareLock,
  type ShareRecord,
} from "@/lib/shares";
import { currentEntry, usePrefs, useWriter } from "@/lib/store";

const optionClass = "w-full rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-40";
const noteClass = "px-3 py-2 text-xs text-muted-foreground";
type Busy = "create" | "update" | "expiry" | "delete" | "check" | null;
type ExpiryChoice = EntryShareExpiry | "keep";

export function SharePopover() {
  const entry = useWriter(currentEntry);
  const sketches = useWriter((s) => s.sketches);
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const [shareReady, setShareReady] = useState<boolean | null>(null);
  const [panel, setPanel] = useState<{
    entryId: string;
    record: ShareRecord | null;
    error: string | null;
    expiry: ExpiryChoice;
  } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    fetch("/api/share")
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then((body) => setShareReady(!!body?.enabled))
      .catch(() => setShareReady(false));
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasPendingShareRecords()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  if (!entry) return null;
  const active = panel?.entryId === entry.id ? panel : null;
  const record = active ? active.record : getShareRecord(entry.id);
  const error = active?.error ?? null;
  const expiry: ExpiryChoice = active?.expiry ?? (record ? "keep" : DEFAULT_ENTRY_SHARE_EXPIRY);
  const persisted = shareRecordIsSaved(entry.id);
  const setPanelState = (
    nextRecord: ShareRecord | null,
    nextError: string | null = null,
    nextExpiry: ExpiryChoice = nextRecord ? "keep" : DEFAULT_ENTRY_SHARE_EXPIRY
  ) => setPanel({ entryId: entry.id, record: nextRecord, error: nextError, expiry: nextExpiry });
  const isWelcome = isWelcomeEntry(entry.content);
  const isEmpty = !entry.content.trim();
  const stale = record !== null && entry.updatedAt > record.entryUpdatedAt;
  const referenced = referencedIds(entry.content);

  const snapshot = () => ({
    content: entry.content,
    fontId,
    fontSize,
    sketches: sketches.filter((s) => referenced.has(s.id)),
    createdAt: entry.createdAt,
  });

  const failureMessage = (body: unknown): string => {
    const message = (body as { error?: unknown } | null)?.error;
    return typeof message === "string" ? message : "Something went wrong — try again";
  };

  const create = async () => {
    const complete = beginEntryShareMutation(entry.id);
    setBusy("create");
    try {
      await withShareLock(async () => {
        assertShareStorage();
        const prepared = prepareShareRecord(entry.id, entry.updatedAt, expiry === "keep" ? DEFAULT_ENTRY_SHARE_EXPIRY : expiry);
        if (!prepared.pendingCreate) { setPanelState(prepared); return; }
        setPanelState(prepared);
        const res = await fetch("/api/share/entry", {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...snapshot(), expiresIn: prepared.requestedExpiry, id: prepared.id, token: prepared.token }),
      });
      const body = await res.json();
      if (res.status === 410) {
        clearShareRecord(entry.id, prepared.id);
        setPanelState(null, failureMessage(body));
        return;
      }
      if (!res.ok) throw new Error(failureMessage(body));
      const next: ShareRecord = {
        ...prepared, pendingCreate: false,
        expiresAt: body.expiresAt,
      };
      setShareRecord(entry.id, next);
      setPanelState(next);
      });
    } catch (error) {
      setPanelState(getShareRecord(entry.id), error instanceof Error ? error.message : "Couldn't create a share link");
    } finally {
      complete();
      setBusy(null);
    }
  };

  const update = async (expiryOnly = false) => {
    if (!record || (expiryOnly && expiry === "keep")) return;
    const complete = beginEntryShareMutation(entry.id);
    setBusy(expiryOnly ? "expiry" : "update");
    try {
      await withShareLock(async () => {
        const current = getShareRecord(entry.id, true);
        if (!current || current.id !== record.id) throw new Error("This entry's share link changed. Check its controls and try again.");
        const res = await fetch(`/api/share/entry/${record.id}`, {
          method: expiryOnly ? "PATCH" : "PUT",
          signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json", "x-share-token": record.token },
          // Updating the snapshot preserves expiry. Changing expiry preserves the snapshot.
          body: JSON.stringify(expiryOnly ? { expiresIn: expiry } : snapshot()),
      });
      const body = await res.json();
      if (res.status === 410) {
        clearShareRecord(entry.id, record.id);
        setPanelState(null, "That link expired or was deleted — create a new one");
        return;
      }
      if (!res.ok) throw new Error(failureMessage(body));
      const next: ShareRecord = {
        ...record,
        expiresAt: body.expiresAt,
        ...(expiryOnly ? {} : { sharedAt: Date.now(), entryUpdatedAt: entry.updatedAt }),
      };
      setShareRecord(entry.id, next);
      setPanelState(next, null, expiryOnly ? "keep" : expiry);
      });
    } catch (error) {
      setPanelState(getShareRecord(entry.id) ?? record, error instanceof Error ? error.message : "Couldn't update the link", expiry);
    } finally {
      complete();
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!record) return;
    setBusy("delete");
    try {
      await revokeEntryShare(entry.id, record.id);
      setPanelState(null);
    } catch (error) {
      setPanelState(record, error instanceof Error ? error.message : "Couldn't delete the link", expiry);
    } finally {
      setBusy(null);
    }
  };

  const retryStorage = async () => {
    if (!record) return;
    try {
      await withShareLock(async () => {
        setShareRecord(entry.id, record);
        setPanelState(record, null, expiry);
      });
    } catch (error) {
      setPanelState(record, error instanceof Error ? error.message : "Couldn't save the link controls", expiry);
    }
  };

  const checkLink = async () => {
    if (!record) return;
    setBusy("check");
    try {
      await withShareLock(async () => {
        const res = await fetch(`/api/share/entry/${record.id}`, {
          headers: { "x-share-token": record.token }, cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        const body = await res.json();
        if (res.status === 410) {
          // A pending create may still be in flight: Delete link must retire
          // its id before we discard the controls.
          if (record.pendingCreate) throw new Error("Creation is not confirmed. Retry creating the link, or delete it.");
          clearShareRecord(entry.id, record.id);
          setPanelState(null, "That link expired or was deleted — create a new one");
          return;
        }
        if (!res.ok) throw new Error(failureMessage(body));
        const next = { ...record, pendingCreate: false, expiresAt: body.expiresAt };
        setShareRecord(entry.id, next);
        setPanelState(next);
      });
    } catch (error) {
      setPanelState(getShareRecord(entry.id) ?? record, error instanceof Error ? error.message : "Couldn't check the link", expiry);
    } finally { setBusy(null); }
  };

  const copy = async () => {
    if (!record) return;
    try {
      await navigator.clipboard.writeText(shareUrl(record.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setPanelState(record, "Couldn't copy the link. Select the address above to copy it.", expiry);
    }
  };

  const expiryPicker = (
    <label className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">Expires</span>
      <select
        aria-label="Link expiry"
        value={expiry}
        disabled={busy !== null || !persisted || !!record?.pendingCreate}
        className="max-w-44 rounded bg-background py-1 text-foreground focus-visible:outline focus-visible:outline-1"
        onChange={(event) => setPanelState(record, null, event.target.value as ExpiryChoice)}
      >
        {record && <option value="keep">{record.expiresAt === null ? "Never (current)" : (record.expiresAt <= now ? "Check expiry" : `In ${expiresLabel(record.expiresAt, now)} (current)`)}</option>}
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
        <option value="never">Never</option>
      </select>
    </label>
  );

  return (
    <Popover onOpenChange={() => setNow(Date.now())}>
      <PopoverTrigger className="text-muted-foreground transition-colors hover:text-foreground">Share</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-72 p-2">
        {shareReady === false ? (
          <p className={noteClass}>Sharing isn&apos;t configured on this deployment.</p>
        ) : isWelcome ? (
          <p className={noteClass}>This is the guide. Write your own entry first, then share it.</p>
        ) : isEmpty && !record ? (
          <p className={noteClass}>Write something first, then share it.</p>
        ) : record === null ? (
          <div className="flex flex-col gap-1">
            <p className={noteClass}>Publish this entry as a read-only page. Anyone with the link can read it. You can delete the link at any time.</p>
            {expiryPicker}
            <button className={optionClass} onClick={create} disabled={busy !== null || shareReady === null}>
              {busy === "create" ? "Creating link…" : "Create link"}
            </button>
            {error && <p role="alert" className={noteClass}>{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="select-all truncate px-3 pt-2 text-xs text-muted-foreground">{shareUrl(record.id)}</p>
            <button className={optionClass} onClick={copy} disabled={!persisted || record.pendingCreate}>{copied ? "Copied" : "Copy link"}</button>
            {!persisted && (
              <>
                <p role="alert" className={noteClass}>The link controls aren&apos;t saved yet. Keep this tab open until you save them or delete the link.</p>
                <button className={optionClass} onClick={retryStorage} disabled={busy !== null}>Retry saving link controls</button>
              </>
            )}
            {record.pendingCreate && (
              <>
                <p className={noteClass}>Creation is not confirmed yet. Retry when the controls are saved, or delete the link.</p>
                <button className={optionClass} onClick={create} disabled={busy !== null || !persisted || isEmpty}>{busy === "create" ? "Creating link…" : "Retry creating link"}</button>
              </>
            )}
            {expiryPicker}
            <button className={optionClass} onClick={checkLink} disabled={busy !== null || !persisted}>{busy === "check" ? "Checking…" : "Check link"}</button>
            {expiry !== "keep" && (
              <button className={optionClass} onClick={() => update(true)} disabled={busy !== null || !persisted || record.pendingCreate}>
                {busy === "expiry" ? "Saving…" : "Save expiry"}
              </button>
            )}
            {stale && !record.pendingCreate && (
              <button className={optionClass} onClick={() => update()} disabled={busy !== null || !persisted || isEmpty}>
                {busy === "update" ? "Updating…" : "Update link — entry has changed"}
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
              Anyone with the link can read this entry. {record.expiresAt === null ? "It stays available until you delete the link." : record.expiresAt <= now ? "Check the link to confirm whether it is still available." : `It expires in ${expiresLabel(record.expiresAt, now)}.`}
            </p>
            <p className="px-3 pb-2 text-xs text-muted-foreground">Link controls stay in this browser. Clearing browser data removes your access to them.</p>
            {error && <p role="alert" className={noteClass}>{error}</p>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
