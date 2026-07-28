"use client";

import { useEffect, useState } from "react";

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
import { Dot } from "@/components/reader-nav";
import { formatBytes } from "@/lib/tts/size";
import {
  clearAudioCache,
  collectGarbage,
  removeVoices,
  requestPersistence,
  storageReport,
  type StorageReport,
} from "@/lib/tts/store";

const itemClass =
  "text-muted-foreground transition-colors hover:text-foreground";

type Confirming = "audio" | "voices" | null;

export function StorageLine() {
  const [report, setReport] = useState<StorageReport | null>(null);
  // Assume durable until the browser says otherwise, so the warning only ever
  // appears on an actual refusal rather than while the answer is in flight.
  const [durable, setDurable] = useState(true);
  const [confirming, setConfirming] = useState<Confirming>(null);

  useEffect(() => {
    void (async () => {
      // The collector otherwise only ran when the audiobook transport
      // unmounted, so someone who stopped opening the reader never reclaimed
      // anything. Sweeping before the report also keeps the number honest.
      await collectGarbage();
      const swept = await storageReport();
      setReport(swept);
      // Only ask once there is something worth keeping: persist() prompts in
      // some browsers, and asking someone who has never pressed Listen is
      // noise about a cache they don't have.
      if (swept.audioBytes > 0) setDurable(await requestPersistence());
    })();
  }, []);

  const run = async (job: Promise<void>) => {
    setConfirming(null);
    await job;
    setReport(await storageReport());
  };

  // Nothing generated and no voice downloaded — there is no storage to manage
  // and no reason to put a number in front of someone who never listens.
  if (!report || (report.audioBytes === 0 && report.voiceBytes === 0)) {
    return null;
  }

  // Naming the downloads is the reassurance the dialog exists to give: this is
  // the moment someone decides whether Clear costs them the article they saved
  // for a flight.
  const kept =
    report.pinned === 0
      ? "Downloads are always kept"
      : report.pinned === 1
        ? "Your one download is kept"
        : `All ${report.pinned} of your downloads are kept`;

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 pt-4 text-[13px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setConfirming("voices")}
          disabled={report.voiceBytes === 0}
          className={`${itemClass} disabled:opacity-40`}
        >
          Voices {formatBytes(report.voiceBytes)}
        </button>
        <Dot />
        <span>Audio {formatBytes(report.audioBytes)}</span>
        <Dot />
        <button
          type="button"
          onClick={() => setConfirming("audio")}
          disabled={report.clearableBytes === 0}
          className={`${itemClass} disabled:opacity-40`}
        >
          Clear
        </button>
        {!durable && (
          <>
            <Dot />
            <span>The browser may still evict downloads</span>
          </>
        )}
      </div>

      <AlertDialog
        open={confirming === "audio"}
        onOpenChange={(isOpen) => !isOpen && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the audio cache?</AlertDialogTitle>
            <AlertDialogDescription>
              Frees {formatBytes(report.clearableBytes)}. {kept} — everything
              else regenerates the next time you listen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(clearAudioCache())}>
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirming === "voices"}
        onOpenChange={(isOpen) => !isOpen && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the voices?</AlertDialogTitle>
            <AlertDialogDescription>
              Frees {formatBytes(report.voiceBytes)}. Voices re-download the
              next time you listen. Your audio and downloads are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(removeVoices())}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
