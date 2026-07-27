"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { articleSite, readingTime } from "@/lib/articles";
import { deleteArticle, getArticle, putArticle } from "@/lib/db";
import type { Article } from "@/lib/types";

const actionClass =
  "text-[13px] text-muted-foreground transition-colors hover:text-foreground";

export default function ArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [article, setArticle] = useState<Article | null | undefined>(undefined);

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
          <Link href="/read" className={`${actionClass} mt-4 inline-block`}>
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
    article.via === "archive" ? "via archive.ph" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className="min-h-dvh">
      <div className="mx-auto max-w-[650px] px-6 pt-14 pb-28">
        <div className="mb-12 flex items-baseline justify-between">
          <Link href="/read" className={actionClass}>
            ← Read
          </Link>
          <Link href="/" className={actionClass}>
            Write
          </Link>
        </div>

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

        <div className="mt-16 flex gap-4 border-t border-border/60 pt-6">
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer noopener"
            className={actionClass}
          >
            View original
          </a>
          <button
            type="button"
            className="text-[13px] text-muted-foreground transition-colors hover:text-destructive"
            onClick={() => {
              void deleteArticle(article.id).then(() => router.push("/read"));
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </main>
  );
}
