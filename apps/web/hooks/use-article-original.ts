"use client";

import { useEffect, useState } from "react";
import { getPdfOriginal } from "@/lib/db";
import type { Article } from "@/lib/types";

export function useArticleOriginal(article: Article | null | undefined): string | null {
  const id = article?.id;
  const remote = article?.url;
  const [local, setLocal] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!id || remote) return;
    let alive = true;
    let url: string | null = null;
    void getPdfOriginal(id).then((original) => {
      if (!alive || !original) return;
      url = URL.createObjectURL(original.file);
      setLocal({ id, url });
    }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [id, remote]);
  return remote || (local && local.id === id ? local.url : null);
}
