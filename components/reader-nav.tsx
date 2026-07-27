"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { articleMarkdown } from "@/lib/articles";
import {
  articleChatUrl,
  articlePromptFull,
  articlePromptShared,
  linkoutUrl,
  type ChatProvider,
} from "@/lib/chat";
import type { Article } from "@/lib/types";

const itemClass =
  "text-muted-foreground transition-colors hover:text-foreground";

const optionClass =
  "w-full rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent";

function Dot() {
  return <span className="text-muted-foreground/40 select-none">•</span>;
}

function ArticleChatPopover({ article }: { article: Article }) {
  const [copied, setCopied] = useState<ChatProvider | null>(null);
  const [shareReady, setShareReady] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/share")
      .then((res) => res.json())
      .then((body) => setShareReady(!!body?.enabled))
      .catch(() => setShareReady(false));
  }, []);

  const source = {
    title: article.title,
    byline: article.byline,
    url: article.url,
    text: articleMarkdown(article),
  };

  const open = (provider: ChatProvider) => {
    const direct = articleChatUrl(provider, source);
    if (direct.carriesFullText || !shareReady) {
      window.open(direct.url, "_blank", "noopener,noreferrer");
      return;
    }

    // The share upload is async; open the tab now so popup blockers see a
    // user gesture, then point it once the link exists (or at the fallback).
    const win = window.open("", "_blank");
    if (win) win.opener = null;
    const navigate = (url: string) => {
      if (win) win.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    };

    void (async () => {
      try {
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(source),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error);
        const shareUrl = `${window.location.origin}/s/${body.id}`;
        const minutes = Math.max(1, Math.round(body.ttlSeconds / 60));
        navigate(
          linkoutUrl(provider, articlePromptShared(source, shareUrl, minutes))
        );
      } catch {
        navigate(direct.url);
      }
    })();
  };

  const copy = async (provider: ChatProvider) => {
    await navigator.clipboard.writeText(articlePromptFull(source));
    setCopied(provider);
    setTimeout(() => setCopied(null), 1500);
  };

  const linkOnly = !articleChatUrl("claude", source).carriesFullText;

  return (
    <Popover>
      <PopoverTrigger className={itemClass}>Chat</PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-64 p-2">
        <div className="flex flex-col gap-1">
          <button className={optionClass} onClick={() => open("chatgpt")}>
            ChatGPT
          </button>
          <button className={optionClass} onClick={() => open("claude")}>
            Claude
          </button>
          {linkOnly && shareReady === true && (
            <>
              <div className="my-1 h-px bg-border" />
              <p className="px-3 py-2 text-xs text-muted-foreground">
                The article is too long to send directly, so those open with a
                temporary share link that expires on its own.
              </p>
            </>
          )}
          {linkOnly && shareReady !== true && (
            <>
              <div className="my-1 h-px bg-border" />
              <p className="px-3 py-2 text-xs text-muted-foreground">
                The article is too long to send as a link, so those open with
                the title + URL. To paste the full text instead:
              </p>
              <button className={optionClass} onClick={() => copy("chatgpt")}>
                {copied === "chatgpt" ? "Copied" : "Copy full prompt"}
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface TrimControls {
  active: boolean;
  canUndo: boolean;
  canRestore: boolean;
  onStart: () => void;
  onDone: () => void;
  onUndo: () => void;
  onRestore: () => void;
  onCancel: () => void;
}

export function ReaderNav({
  article,
  onDelete,
  trim,
}: {
  article?: Article;
  onDelete?: () => void;
  trim?: TrimControls;
}) {
  const { theme, setTheme } = useTheme();
  const fullscreen = useFullscreen();

  if (trim?.active) {
    return (
      <nav className="fixed inset-x-0 bottom-0 z-40 bg-background">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-4 text-[13px]">
          <button
            type="button"
            onClick={trim.onDone}
            className="text-foreground transition-colors hover:opacity-70"
          >
            Done
          </button>
          <Dot />
          <button
            type="button"
            onClick={trim.onUndo}
            disabled={!trim.canUndo}
            className={`${itemClass} disabled:opacity-40`}
          >
            Undo
          </button>
          {trim.canRestore && (
            <>
              <Dot />
              <button type="button" onClick={trim.onRestore} className={itemClass}>
                Restore original
              </button>
            </>
          )}
          <Dot />
          <button type="button" onClick={trim.onCancel} className={itemClass}>
            Cancel
          </button>
        </div>
      </nav>
    );
  }

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 bg-background">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-4 text-[13px]">
        {article ? (
          <>
            <Link href="/read" className={itemClass}>
              ← Read
            </Link>
            <Dot />
            <ArticleChatPopover article={article} />
            <Dot />
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer noopener"
              className={itemClass}
            >
              Original
            </a>
            {trim && (
              <>
                <Dot />
                <button type="button" onClick={trim.onStart} className={itemClass}>
                  Trim
                </button>
              </>
            )}
            {onDelete && (
              <>
                <Dot />
                <button
                  type="button"
                  onClick={onDelete}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  Delete
                </button>
              </>
            )}
          </>
        ) : (
          <Link href="/" className={itemClass}>
            Write
          </Link>
        )}
        {fullscreen.supported && (
          <>
            <Dot />
            <button
              type="button"
              onClick={fullscreen.toggle}
              className={itemClass}
            >
              {fullscreen.active ? "Minimize" : "Fullscreen"}
            </button>
          </>
        )}
        <Dot />
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Toggle theme"
          className={`flex items-center ${itemClass}`}
        >
          {theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
        </button>
      </div>
    </nav>
  );
}
