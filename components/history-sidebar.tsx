"use client";

import { useState } from "react";
import { Download, Trash2, X } from "lucide-react";

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
import { entryDate, entryFilename, entryPreview } from "@/lib/entries";
import { embedSketches } from "@/lib/sketch-svg";
import { useWriter } from "@/lib/store";
import type { Entry, Sketch } from "@/lib/types";
import { cn } from "@/lib/utils";

function download(entry: Entry, sketches: Sketch[]) {
  const markdown = embedSketches(entry.content, sketches);
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entryFilename(entry);
  a.click();
  URL.revokeObjectURL(url);
}

export function HistorySidebar() {
  const entries = useWriter((s) => s.entries);
  // Every drawing, not the open entry's: which ones a download needs is decided
  // by the references in the entry being downloaded.
  const sketches = useWriter((s) => s.sketches);
  const currentId = useWriter((s) => s.currentId);
  const open = useWriter((s) => s.sidebarOpen);
  const setOpen = useWriter((s) => s.setSidebarOpen);
  const select = useWriter((s) => s.select);
  const remove = useWriter((s) => s.remove);

  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
            <h2 className="text-sm text-foreground">History</h2>
            <p className="text-xs text-muted-foreground">
              saved locally in this browser
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close history"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <ul className="flex flex-col gap-px px-2 pb-4">
            {entries.map((entry) => {
              const preview = entryPreview(entry);
              return (
                <li key={entry.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => select(entry.id)}
                    className={cn(
                      "w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent",
                      entry.id === currentId && "bg-accent"
                    )}
                  >
                    <span
                      className={cn(
                        "block truncate pr-16 text-sm",
                        preview ? "text-foreground" : "text-muted-foreground/60"
                      )}
                    >
                      {preview || "Empty entry"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {entryDate(entry)}
                    </span>
                  </button>
                  <span className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => download(entry, sketches)}
                      title="Download as markdown"
                      className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Download className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeleteError(null); setDeleting(entry); }}
                      title="Delete entry"
                      className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      {open && (
        <button
          type="button"
          aria-label="Close history"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && !deleteBusy && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? `"${entryPreview(deleting) || "Empty entry"}" — ` : ""}
              this can&apos;t be undone. If shared, its link will be deleted too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="text-sm text-muted-foreground">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              onClick={async (event) => {
                event.preventDefault();
                if (!deleting) return;
                setDeleteBusy(true);
                setDeleteError(null);
                try {
                  await remove(deleting.id);
                  setDeleting(null);
                } catch (error) {
                  setDeleteError(error instanceof Error ? error.message : "Couldn't delete this entry. Try again.");
                } finally {
                  setDeleteBusy(false);
                }
              }}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
