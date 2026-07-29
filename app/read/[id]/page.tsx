"use client";

import "katex/dist/katex.min.css";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";

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
import { ArticleTitle } from "@/components/article-title";
import { Audiobook } from "@/components/audiobook";
import { HighlightLayer } from "@/components/highlight-layer";
import { ReaderNav } from "@/components/reader-nav";
import {
  articleSite,
  htmlWordCount,
  readingTime,
  splitBlocks,
  viaLabel,
} from "@/lib/articles";
import { deleteArticle, getArticle, putArticle } from "@/lib/db";
import { SYNC_APPLIED_EVENT } from "@/lib/sync";
import type { Article, Highlight } from "@/lib/types";

interface TrimSession {
  blocks: string[];
  undo: string[][];
  // The session's starting blocks, joined — stored as contentOriginal on the
  // first trim so a later Restore round-trips to byte-identical content.
  original: string;
}

export default function ArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [article, setArticle] = useState<Article | null | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [trim, setTrim] = useState<TrimSession | null>(null);
  // Mounting the transport is what loads the model and starts synthesis, so
  // an article nobody asks to hear costs nothing.
  const [listening, setListening] = useState(false);
  const bodyRef = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const trimActive = trim !== null;

  useEffect(() => {
    void getArticle(id).then((found) => {
      setArticle(found ?? null);
      if (found && !found.readAt) {
        const now = Date.now();
        void putArticle({ ...found, readAt: now, updatedAt: now });
      }
    });
  }, [id]);

  // Highlights (or the article itself) may change on another device while
  // this one is open — pick up synced state, but never under an open trim
  // session, whose Done would overwrite it with stale content.
  useEffect(() => {
    if (trimActive) return;
    const refresh = () => {
      void getArticle(id).then((found) => {
        if (found) setArticle(found);
      });
    };
    window.addEventListener(SYNC_APPLIED_EVENT, refresh);
    return () => window.removeEventListener(SYNC_APPLIED_EVENT, refresh);
  }, [id, trimActive]);

  // TeX arrives stored as <span class="math">…</span>; render it with KaTeX
  // after the HTML is in the DOM. KaTeX only loads for articles that have
  // math, and re-runs when trim rebuilds the blocks.
  const hasMath = !!article?.content.includes('class="math');
  const trimBlocks = trim?.blocks;
  useEffect(() => {
    if (!hasMath) return;
    let cancelled = false;
    void import("katex").then(({ default: katex }) => {
      if (cancelled || !bodyRef.current) return;
      const spans =
        bodyRef.current.querySelectorAll<HTMLElement>("span.math:not(:has(.katex))");
      for (const el of spans) {
        katex.render(el.textContent ?? "", el, {
          displayMode: el.classList.contains("math-display"),
          throwOnError: false,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasMath, article?.content, trimBlocks]);

  if (article === undefined) return <main className="min-h-dvh" />;

  if (article === null) {
    return (
      <main className="min-h-dvh">
        <div className="mx-auto max-w-[650px] px-6 pt-14">
          <p className="text-sm text-muted-foreground">
            This article isn&apos;t saved in this browser.
          </p>
          <Link
            href="/read"
            className="mt-4 inline-block text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Read
          </Link>
        </div>
      </main>
    );
  }

  const meta = [
    article.byline,
    articleSite(article),
    readingTime(article.wordCount),
    viaLabel(article.via),
  ]
    .filter(Boolean)
    .join(" · ");

  const removeBlock = (index: number) => {
    setTrim((session) =>
      session
        ? {
            ...session,
            blocks: session.blocks.filter((_, i) => i !== index),
            undo: [...session.undo, session.blocks],
          }
        : session
    );
  };

  const rename = (title: string) => {
    const updated: Article = { ...article, title, updatedAt: Date.now() };
    void putArticle(updated);
    setArticle(updated);
  };

  const saveHighlights = (highlights: Highlight[]) => {
    const updated: Article = {
      ...article,
      highlights: highlights.length ? highlights : undefined,
      updatedAt: Date.now(),
    };
    void putArticle(updated);
    setArticle(updated);
  };

  const finishTrim = async () => {
    if (!trim) return;
    const content = trim.blocks.join("\n");
    if (content !== article.content) {
      const updated: Article = {
        ...article,
        content,
        wordCount: htmlWordCount(content),
        contentOriginal: article.contentOriginal ?? trim.original,
      };
      await putArticle(updated);
      setArticle(updated);
    }
    setTrim(null);
  };

  const trimControls = {
    active: trim !== null,
    canUndo: (trim?.undo.length ?? 0) > 0,
    canRestore:
      !!article.contentOriginal && article.contentOriginal !== article.content,
    onStart: () => {
      const blocks = splitBlocks(article.content);
      setTrim({ blocks, undo: [], original: blocks.join("\n") });
    },
    onDone: () => void finishTrim(),
    onUndo: () =>
      setTrim((session) =>
        session && session.undo.length > 0
          ? {
              ...session,
              blocks: session.undo[session.undo.length - 1],
              undo: session.undo.slice(0, -1),
            }
          : session
      ),
    onRestore: () =>
      setTrim((session) =>
        session && article.contentOriginal
          ? {
              ...session,
              blocks: splitBlocks(article.contentOriginal),
              undo: [...session.undo, session.blocks],
            }
          : session
      ),
    onCancel: () => setTrim(null),
  };

  return (
    <main className="min-h-dvh">
      <div ref={wrapRef} className="relative mx-auto max-w-[650px] px-6 pt-14 pb-32">
        {trim && (
          <p className="mb-8 font-sans text-xs text-muted-foreground">
            Trimming — click a block to remove it. Nothing is saved until Done.
          </p>
        )}
        <article
          ref={bodyRef}
          style={{ fontFamily: "var(--font-crimson), Georgia, serif" }}
        >
          <ArticleTitle title={article.title} onRename={rename} />
          <p className="mt-3 font-sans text-xs text-muted-foreground">
            {meta}
            {meta && " · "}
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              original
            </a>
          </p>
          {trim ? (
            <div className="reader mt-10 select-none">
              {trim.blocks.map((block, i) => (
                <div
                  key={`${i}-${block.length}`}
                  onClickCapture={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removeBlock(i);
                  }}
                  title="Click to remove"
                  className="-mx-2 cursor-pointer rounded-sm px-2 transition-colors hover:bg-destructive/10"
                  dangerouslySetInnerHTML={{ __html: block }}
                />
              ))}
              {trim.blocks.length === 0 && (
                <p className="font-sans text-sm text-muted-foreground">
                  Nothing left — Undo, or Cancel to keep the article as it was.
                </p>
              )}
            </div>
          ) : (
            <div
              ref={contentRef}
              className="reader mt-10"
              dangerouslySetInnerHTML={{ __html: article.content }}
            />
          )}
        </article>
        {!trim && (
          <HighlightLayer
            article={article}
            contentRef={contentRef}
            wrapRef={wrapRef}
            onSave={saveHighlights}
          />
        )}
      </div>

      <ReaderNav
        article={article}
        onDelete={() => setConfirmingDelete(true)}
        trim={trimControls}
        listen={{
          active: listening,
          onToggle: () => setListening((on) => !on),
        }}
        banner={
          listening && !trim ? (
            <Audiobook
              article={article}
              contentRef={contentRef}
              wrapRef={wrapRef}
            />
          ) : null
        }
      />

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this article?</AlertDialogTitle>
            <AlertDialogDescription>
              {article.title} — this can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void deleteArticle(article.id).then(() => router.push("/read"));
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
