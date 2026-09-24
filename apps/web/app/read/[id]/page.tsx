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
import { ArticleEditor, type ArticleEditorHandle } from "@/components/article-editor";
import { sanitizeContent } from "@/lib/article-html";
import { ArticleTitle } from "@/components/article-title";
import { Audiobook } from "@/components/audiobook";
import { HighlightLayer } from "@/components/highlight-layer";
import { ReaderNav } from "@/components/reader-nav";
import {
  articleSite,
  htmlWordCount,
  readingTime,
  viaLabel,
} from "@/lib/articles";
import { deleteArticle, getArticle, putArticle, saveArticleContent } from "@/lib/db";
import { SYNC_APPLIED_EVENT } from "@/lib/sync";
import { useArticleOriginal } from "@/hooks/use-article-original";
import type { Article, Highlight } from "@/lib/types";

interface EditSession {
  original: string;
  changed: boolean;
  canUndo: boolean;
}

export default function ArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [article, setArticle] = useState<Article | null | undefined>(undefined);
  const originalUrl = useArticleOriginal(article);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [edit, setEdit] = useState<EditSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editorRef = useRef<ArticleEditorHandle>(null);
  // Mounting the transport is what loads the model and starts synthesis, so
  // an article nobody asks to hear costs nothing.
  const [listening, setListening] = useState(false);
  const bodyRef = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const editActive = edit !== null;

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
  // this one is open. Keep an open editor stable; Done checks the latest body
  // inside its save transaction and refuses conflicting content changes.
  useEffect(() => {
    if (editActive) return;
    const refresh = () => {
      void getArticle(id).then((found) => {
        if (found) setArticle(found);
      });
    };
    window.addEventListener(SYNC_APPLIED_EVENT, refresh);
    return () => window.removeEventListener(SYNC_APPLIED_EVENT, refresh);
  }, [id, editActive]);

  // TeX arrives stored as <span class="math">…</span>; render it with KaTeX
  // after the HTML is in the DOM. KaTeX only loads for articles that have
  // math. Leave TeX source editable; never put rendered KaTeX into saved HTML.
  const hasMath = !!article?.content.includes('class="math');
  useEffect(() => {
    if (!hasMath || editActive) return;
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
  }, [hasMath, article?.content, editActive]);

  useEffect(() => {
    if (!edit?.changed) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edit?.changed]);

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

  const finishEdit = async () => {
    if (!edit || !editorRef.current || saving) return;
    const draft = editorRef.current.content();
    const content = draft === edit.original || draft === article.contentOriginal
      ? draft : sanitizeContent(draft, article.url);
    if (content.length > 2_000_000) {
      setEditError("This article is too large to save. Shorten it and try again.");
      return;
    }
    setSaving(true); setEditError(null);
    try {
      const updated = await saveArticleContent(article.id, edit.original, content, htmlWordCount(content));
      setArticle(updated); setEdit(null);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Couldn't save this edit. Your text is still here; try again.");
    } finally { setSaving(false); }
  };

  const editControls = {
    active: edit !== null,
    saving,
    canUndo: edit?.canUndo ?? false,
    canRestore: !!edit && (edit.changed || article.contentOriginal !== undefined && article.contentOriginal !== edit.original),
    onStart: () => {
      setListening(false); setEditError(null);
      setEdit({ original: article.content, changed: false, canUndo: false });
    },
    onDone: () => void finishEdit(),
    onUndo: () => editorRef.current?.undo(),
    onRestore: () => editorRef.current?.restore(article.contentOriginal ?? edit!.original),
    onCancel: () => {
      setEdit(null); setEditError(null);
      void getArticle(id).then((found) => setArticle(found ?? null));
    },
  };

  return (
    <main className="min-h-dvh">
      <div ref={wrapRef} className="relative mx-auto max-w-[650px] px-6 pt-14 pb-32">
        {edit && (
          <p className="mb-8 font-sans text-xs text-muted-foreground">
            Edit any text, or select and delete what you don’t need. Nothing is saved until Done.
          </p>
        )}
        <article
          ref={bodyRef}
          style={{ fontFamily: "var(--font-crimson), Georgia, serif" }}
        >
          {edit ? <h1 className="text-3xl leading-tight">{article.title}</h1>
            : <ArticleTitle title={article.title} onRename={rename} />}
          <p className="mt-3 font-sans text-xs text-muted-foreground">
            {meta}
            {meta && originalUrl && " · "}
            {originalUrl && <a
              href={originalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              original
            </a>}
          </p>
          {edit ? (
            <ArticleEditor initial={edit.original} editorRef={editorRef} disabled={saving}
              onChange={(state) => setEdit((current) => current ? { ...current, ...state } : current)} />
          ) : (
            <div
              ref={contentRef}
              className="reader mt-10"
              dangerouslySetInnerHTML={{ __html: article.content }}
            />
          )}
        </article>
        {!edit && (
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
        originalUrl={originalUrl}
        onDelete={() => setConfirmingDelete(true)}
        edit={editControls}
        listen={{
          active: listening,
          onToggle: () => setListening((on) => !on),
        }}
        banner={editError ? <p role="alert" className="mx-auto max-w-[650px] px-6 pt-4 text-sm text-muted-foreground">{editError}</p> :
          listening && !edit ? (
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
