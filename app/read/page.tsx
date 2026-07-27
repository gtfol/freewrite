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
import { ReaderNav } from "@/components/reader-nav";
import { useMounted } from "@/hooks/use-mounted";
import {
  articleDate,
  articleSite,
  plainTextToHtml,
  readingTime,
  requestExtract,
  sourceToVia,
  toArticle,
  viaLabel,
} from "@/lib/articles";
import { deleteArticle, listArticles, putArticle } from "@/lib/db";
import type { Article, ExtractedArticle, ExtractSource } from "@/lib/types";
import { cn } from "@/lib/utils";

const THIN_WORD_COUNT = 80;

type AddState =
  | { kind: "idle" }
  | { kind: "loading"; source: ExtractSource }
  | { kind: "error"; message: string; url: string; tried: ExtractSource[] }
  | {
      kind: "thin";
      data: ExtractedArticle;
      url: string;
      source: ExtractSource;
      tried: ExtractSource[];
    }
  | { kind: "paste"; url: string; tried: ExtractSource[] };

const actionClass =
  "text-[13px] text-muted-foreground transition-colors hover:text-foreground";

const retryClass =
  "text-[13px] text-foreground transition-colors hover:opacity-70";

const LOADING_LABELS: Record<ExtractSource, string> = {
  direct: "Saving…",
  archive: "Checking archive…",
  paste: "Saving…",
};

function RetryButtons({
  tried,
  onRetry,
  onPaste,
}: {
  tried: ExtractSource[];
  onRetry: (source: ExtractSource) => void;
  onPaste: () => void;
}) {
  return (
    <>
      <button className={retryClass} onClick={onPaste}>
        Paste the text yourself
      </button>
      {!tried.includes("archive") && (
        <button className={retryClass} onClick={() => onRetry("archive")}>
          Try the archive.ph copy
        </button>
      )}
    </>
  );
}

export default function ReadPage() {
  const mounted = useMounted();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [input, setInput] = useState("");
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [deleting, setDeleting] = useState<Article | null>(null);

  useEffect(() => {
    void listArticles().then(setArticles);
  }, []);

  const save = async (data: ExtractedArticle, source: ExtractSource) => {
    const article = toArticle(data, sourceToVia(source));
    await putArticle(article);
    setArticles((prev) => [article, ...(prev ?? [])]);
    setInput("");
    setState({ kind: "idle" });
  };

  const submit = async (
    url: string,
    source: ExtractSource,
    tried: ExtractSource[] = [],
    html?: string
  ) => {
    if (!url.trim()) return;
    setState({ kind: "loading", source });
    const nowTried = [...tried, source];
    try {
      const data = await requestExtract(url, source, html);
      if (data.wordCount < THIN_WORD_COUNT && source === "direct") {
        setState({ kind: "thin", data, url, source, tried: nowTried });
      } else {
        await save(data, source);
      }
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Something went wrong",
        url,
        tried: nowTried,
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
      <div className="mx-auto max-w-[650px] px-6 pt-14 pb-28">
        <h1 className="mb-10 text-sm text-foreground">Read</h1>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input, "direct");
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
            {state.kind === "loading" ? LOADING_LABELS[state.source] : "Save"}
          </button>
        </form>

        {state.kind === "error" && (
          <div className="mt-4 text-[13px] text-muted-foreground">
            <p>{state.message}</p>
            <div className="mt-2 flex flex-wrap gap-4">
              <RetryButtons
                tried={state.tried}
                onRetry={(source) => void submit(state.url, source, state.tried)}
                onPaste={() =>
                  setState({ kind: "paste", url: state.url, tried: state.tried })
                }
              />
              <button
                className={actionClass}
                onClick={() => setState({ kind: "idle" })}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {state.kind === "paste" && (
          <div className="mt-4 text-[13px] text-muted-foreground">
            <p>
              Open the page in your browser, select everything on it, copy,
              then paste below. Formatting comes along when the page allows it.
            </p>
            <textarea
              autoFocus
              value=""
              onChange={() => {}}
              onPaste={(e) => {
                e.preventDefault();
                const html = e.clipboardData.getData("text/html");
                const text = e.clipboardData.getData("text/plain");
                if (!html && !text.trim()) return;
                void submit(
                  state.url,
                  "paste",
                  state.tried,
                  html || plainTextToHtml(text)
                );
              }}
              placeholder="Paste here"
              className="mt-3 h-24 w-full resize-none rounded-md border border-border bg-transparent p-3 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
            />
            <button
              className={actionClass}
              onClick={() => setState({ kind: "idle" })}
            >
              Cancel
            </button>
          </div>
        )}

        {state.kind === "thin" && (
          <div className="mt-4 text-[13px] text-muted-foreground">
            <p>
              Only pulled {state.data.wordCount} words — the page may be gated
              or rendered in the browser.
            </p>
            <div className="mt-2 flex flex-wrap gap-4">
              <RetryButtons
                tried={state.tried}
                onRetry={(source) => void submit(state.url, source, state.tried)}
                onPaste={() =>
                  setState({ kind: "paste", url: state.url, tried: state.tried })
                }
              />
              <button
                className={actionClass}
                onClick={() => void save(state.data, state.source)}
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
                    viaLabel(article.via),
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

      <ReaderNav />

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
