"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  formatBytes,
  sliceWidths,
  storageSlices,
  type StorageSlice,
} from "@/lib/tts/size";
import {
  clearCache,
  removeAllDownloads,
  requestPersistence,
  storageReport,
  type StorageReport,
} from "@/lib/tts/store";
import { cn } from "@/lib/utils";

// Ordered as the bar stacks them. Voices lead because they are usually the
// largest slice and the one nobody expects.
const SLICE_COLOR: Record<StorageSlice["key"], string> = {
  voices: "bg-foreground/70",
  downloads: "bg-foreground/45",
  cache: "bg-foreground/25",
  other: "bg-foreground/10",
};

type Confirming = "downloads" | "cache" | null;

function Action({
  label,
  caption,
  disabled,
  onClick,
}: {
  label: string;
  caption: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="px-4 pt-6">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="w-full rounded-full border border-border py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {label}
      </button>
      <p className="mt-2 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

export function StorageSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [report, setReport] = useState<StorageReport | null>(null);
  // Assume durable until the browser says otherwise, so the warning only ever
  // appears on an actual refusal rather than while the answer is in flight.
  const [durable, setDurable] = useState(true);
  const [confirming, setConfirming] = useState<Confirming>(null);

  const refresh = useCallback(async () => {
    const next = await storageReport();
    setReport(next);
    // Only ask once there is something worth keeping: persist() prompts in
    // some browsers, and asking someone who has never pressed Listen is noise
    // about a cache they don't have.
    if (next.audioBytes > 0) setDurable(await requestPersistence());
  }, []);

  // Measured on open rather than on mount — the panel lives in the nav, so a
  // mount-time read would run on every page and go stale the moment anything
  // was generated.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      await refresh();
    })();
  }, [open, refresh]);

  const run = async (job: Promise<void>) => {
    setConfirming(null);
    await job;
    await refresh();
  };

  const slices = report ? storageSlices(report) : [];
  const widths = report ? sliceWidths(slices, report.quotaBytes) : [];
  const downloads = slices.find((slice) => slice.key === "downloads");

  return (
    <>
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-72 flex-col border-l bg-background transition-transform duration-300",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <div>
            <h2 className="text-sm text-foreground">Storage</h2>
            <p className="text-xs text-muted-foreground">
              what&apos;s saved on this device
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close storage"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-4">
          {/* The unfilled remainder is the free space, which is why nothing
              here draws it: the track showing through is the point. */}
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-border">
            {slices.map((slice, i) => (
              <div
                key={slice.key}
                className={SLICE_COLOR[slice.key]}
                style={{ width: `${widths[i]}%` }}
              />
            ))}
          </div>

          <ul className="mt-4 flex flex-col gap-2">
            {slices.map((slice) => (
              <li
                key={slice.key}
                className="flex items-center gap-2 text-[13px]"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    SLICE_COLOR[slice.key]
                  )}
                />
                <span className="text-muted-foreground">{slice.label}</span>
                <span className="ml-auto tabular-nums text-foreground">
                  {formatBytes(slice.bytes)}
                </span>
              </li>
            ))}
          </ul>

          {report && (
            <p className="mt-4 text-xs text-muted-foreground">
              {/* "About" carries the hedge the figure needs: a quota is the
                  browser's estimate of a shared ceiling, fuzzed to resist
                  fingerprinting, not a measurement of the disk. */}
              About{" "}
              {formatBytes(Math.max(0, report.quotaBytes - report.usageBytes))}{" "}
              free.
              {!durable &&
                " If the device fills up, the browser may delete some of this without asking."}
            </p>
          )}
        </div>

        <Action
          label="Remove all downloads"
          caption="Deletes the audio files you downloaded for your articles."
          disabled={!downloads || downloads.bytes === 0}
          onClick={() => setConfirming("downloads")}
        />
        <Action
          label="Clear cache"
          caption="Removes stale audio files and the voice models. Your downloads are kept."
          disabled={
            !report || (report.clearableBytes === 0 && report.voiceBytes === 0)
          }
          onClick={() => setConfirming("cache")}
        />
      </aside>

      {open && (
        <button
          type="button"
          aria-label="Close storage"
          onClick={onClose}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}

      <AlertDialog
        open={confirming === "downloads"}
        onOpenChange={(isOpen) => !isOpen && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all downloads?</AlertDialogTitle>
            <AlertDialogDescription>
              Frees {formatBytes(downloads?.bytes ?? 0)}. Only the audio is
              deleted. Your articles are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(removeAllDownloads())}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirming === "cache"}
        onOpenChange={(isOpen) => !isOpen && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the cache?</AlertDialogTitle>
            {/* The size of the re-download isn't repeated here: the Voices row
                sits directly above the button that opened this. */}
            <AlertDialogDescription>
              Frees{" "}
              {formatBytes(
                (report?.clearableBytes ?? 0) + (report?.voiceBytes ?? 0)
              )}
              . Your downloads are kept. Voice models will be downloaded again
              the next time you listen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(clearCache())}>
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
