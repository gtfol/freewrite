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
import { ScrollArea } from "@/components/ui/scroll-area";
import { entryDate, entryFilename, entryPreview } from "@/lib/entries";
import { useWriter } from "@/lib/store";
import type { Entry } from "@/lib/types";
import { cn } from "@/lib/utils";

function download(entry: Entry) {
  const blob = new Blob([entry.content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entryFilename(entry);
  a.click();
  URL.revokeObjectURL(url);
}

export function HistorySidebar() {
  const entries = useWriter((s) => s.entries);
  const currentId = useWriter((s) => s.currentId);
  const open = useWriter((s) => s.sidebarOpen);
  const setOpen = useWriter((s) => s.setSidebarOpen);
  const select = useWriter((s) => s.select);
  const remove = useWriter((s) => s.remove);

  const [deleting, setDeleting] = useState<Entry | null>(null);

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

        <ScrollArea className="flex-1">
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
                        "block truncate pr-12 text-sm",
                        preview ? "text-foreground" : "text-muted-foreground/60"
                      )}
                    >
                      {preview || "Empty entry"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {entryDate(entry)}
                    </span>
                  </button>
                  <span className="absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-1.5 group-hover:flex">
                    <button
                      type="button"
                      onClick={() => download(entry)}
                      title="Download as markdown"
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Download className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(entry)}
                      title="Delete entry"
                      className="text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
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
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? `"${entryPreview(deleting) || "Empty entry"}" — ` : ""}
              this can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) void remove(deleting.id);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
