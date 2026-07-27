"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

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
import { ReaderNav } from "@/components/reader-nav";
import { articleSite, readingTime, viaLabel } from "@/lib/articles";
import { deleteArticle, getArticle, putArticle } from "@/lib/db";
import type { Article } from "@/lib/types";

export default function ArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [article, setArticle] = useState<Article | null | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    void getArticle(id).then((found) => {
      setArticle(found ?? null);
      if (found && !found.readAt) {
        void putArticle({ ...found, readAt: Date.now() });
      }
    });
  }, [id]);

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

  return (
    <main className="min-h-dvh">
      <div className="mx-auto max-w-[650px] px-6 pt-14 pb-32">
        <article style={{ fontFamily: "var(--font-crimson), Georgia, serif" }}>
          <h1 className="text-[1.75rem] leading-tight font-semibold">
            {article.title}
          </h1>
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
          <div
            className="reader mt-10"
            dangerouslySetInnerHTML={{ __html: article.content }}
          />
        </article>
      </div>

      <ReaderNav article={article} onDelete={() => setConfirmingDelete(true)} />

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
