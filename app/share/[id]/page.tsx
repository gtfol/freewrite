import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";

import { SharedEntry } from "@/components/shared-entry";
import { getEntryShare, shareEnabled } from "@/lib/share";

export const runtime = "nodejs";

// generateMetadata and the page both need the snapshot — cache() keeps it
// to one KV read per request.
const loadShare = cache(async (id: string) => {
  if (!shareEnabled()) return null;
  try {
    return await getEntryShare(id);
  } catch {
    return null;
  }
});

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

function shareTitle(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "freewrite";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const share = await loadShare(id);
  return { title: share ? shareTitle(share.content) : "freewrite" };
}

export default async function SharedEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const share = await loadShare(id);

  if (!share) {
    return (
      <main className="min-h-dvh">
        <div className="mx-auto max-w-[650px] px-6 pt-14">
          <p className="text-sm text-muted-foreground">
            This shared entry has expired, or its link was deleted.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            ← freewrite
          </Link>
        </div>
      </main>
    );
  }

  const words = share.content.trim().split(/\s+/).length;
  const meta = [
    dateFormat.format(new Date(share.createdAt)),
    `${words} ${words === 1 ? "word" : "words"}`,
  ].join(" · ");

  return (
    <SharedEntry
      content={share.content}
      fontId={share.fontId}
      fontSize={share.fontSize}
      meta={meta}
    />
  );
}
