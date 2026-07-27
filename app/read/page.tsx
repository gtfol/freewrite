"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import {
  articleDate,
  articleSite,
  readingTime,
  requestExtract,
  toArticle,
} from "@/lib/articles";
import { deleteArticle, listArticles, putArticle } from "@/lib/db";
import type { Article, ExtractedArticle } from "@/lib/types";
import { cn } from "@/lib/utils";

const THIN_WORD_COUNT = 80;

type AddState =
  | { kind: "idle" }
  | { kind: "loading"; archive: boolean }
  | { kind: "error"; message: string; url: string; archiveTried: boolean }
  | { kind: "thin"; data: ExtractedArticle; url: string; archive: boolean };

const actionClass =
  "text-[13px] text-muted-foreground transition-colors hover:text-foreground";

export default function ReadPage() {
  const mounted = useMounted();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [input, setInput] = useState("");
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [deleting, setDeleting] = useState<Article | null>(null);

  useEffect(() => {
    void listArticles().then(setArticles);
  }, []);

  const save = async (data: ExtractedArticle, archive: boolean) => {
    const article = toArticle(data, archive ? "archive" : null);
    await putArticle(article);
    setArticles((prev) => [article, ...(prev ?? [])]);
    setInput("");
    setState({ kind: "idle" });
  };

  const submit = async (url: string, archive: boolean) => {
    if (!url.trim()) return;
    setState({ kind: "loading", archive });
    try {
      const data = await requestExtract(url, archive);
      if (data.wordCount < THIN_WORD_COUNT && !archive) {
        setState({ kind: "thin", data, url, archive });
      } else {
        await save(data, archive);
      }
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Something went wrong",
        url,
        archiveTried: archive,
      });
    }
  };

  const remove = async (article: Article) => {
    await deleteArticle(article.id);
    setArticles((prev) => (prev ?? []).filter((a) => a.id !== article.id));
  };

  if (!mounted) return <main className="min-h-dvh" />;

  return (
    <main className="min-h-dvh">
      <div className="mx-auto max-w-[650px] px-6 pt-14 pb-24">
        <div className="mb-10 flex items-baseline justify-between">
          <h1 className="text-sm text-foreground">Read</h1>
          <Link href="/" className={actionClass}>
            Write
          </Link>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input, false);
          }}
          className="flex items-center gap-3"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste a link — an article, an x.com post, an arXiv paper"
            className="h-10 border-0 border-b border-border rounded-none px-0 shadow-none focus-visible:ring-0 focus-visible:border-foreground/40"
            disabled={state.kind === "loading"}
          />
          <button
            type="submit"
            disabled={state.kind === "loading" || !input.trim()}
            className={cn(actionClass, "disabled:opacity-40")}
          >
            {state.kind === "loading"
              ? state.archive
                ? "Checking archive…"
                : "Saving…"
              : "Save"}
          </button>
        </form>

        {state.kind === "error" && (
          <div className="mt-4 text-[13px] text-muted-foreground">
            <p>{state.message}</p>
            <div className="mt-2 flex gap-4">
              {!state.archiveTried && (
                <button
                  className="text-foreground transition-colors hover:opacity-70"
                  onClick={() => void submit(state.url, true)}
                >
                  Try the archive.ph copy
                </button>
              )}
              <button
                className={actionClass}
                onClick={() => setState({ kind: "idle" })}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {state.kind === "thin" && (
          <div className="mt-4 text-[13px] text-muted-foreground">
            <p>
              Only pulled {state.data.wordCount} words — the page may be gated.
            </p>
            <div className="mt-2 flex gap-4">
              <button
                className="text-foreground transition-colors hover:opacity-70"
                onClick={() => void submit(state.url, true)}
              >
                Try the archive.ph copy
              </button>
              <button
                className={actionClass}
                onClick={() => void save(state.data, false)}
              >
                Save anyway
              </button>
              <button
                className={actionClass}
                onClick={() => setState({ kind: "idle" })}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <ul className="mt-12 flex flex-col">
          {articles?.map((article) => (
            <li key={article.id} className="group relative border-b border-border/60">
              <Link href={`/read/${article.id}`} className="block py-4 pr-8">
                <span
                  className={cn(
                    "block text-[15px] leading-snug",
                    article.readAt ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  {article.title}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {[
                    articleSite(article),
                    articleDate(article),
                    readingTime(article.wordCount),
                    article.via === "archive" ? "via archive.ph" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </Link>
              <button
                type="button"
                onClick={() => setDeleting(article)}
                title="Delete"
                className="absolute top-1/2 right-0 hidden -translate-y-1/2 text-muted-foreground transition-colors hover:text-destructive group-hover:block"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
          {articles?.length === 0 && (
            <li className="py-4 text-[13px] text-muted-foreground">
              Nothing saved yet. Paste a link above.
            </li>
          )}
        </ul>
      </div>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this article?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.title} — this can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) void remove(deleting);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
