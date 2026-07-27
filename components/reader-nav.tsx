"use client";

import Link from "next/link";
import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { articleText } from "@/lib/articles";
import {
  articleChatUrl,
  articlePromptFull,
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

  const source = {
    title: article.title,
    byline: article.byline,
    url: article.url,
    text: articleText(article),
  };

  const open = (provider: ChatProvider) => {
    const { url } = articleChatUrl(provider, source);
    window.open(url, "_blank", "noopener,noreferrer");
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
          {linkOnly && (
            <>
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

export function ReaderNav({
  article,
  onDelete,
}: {
  article?: Article;
  onDelete?: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const fullscreen = useFullscreen();

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
