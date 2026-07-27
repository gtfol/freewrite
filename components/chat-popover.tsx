"use client";

import { useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  chatUrl,
  fullPrompt,
  isUrlTooLong,
  MIN_CHAT_LENGTH,
  type ChatProvider,
} from "@/lib/chat";
import { isWelcomeEntry } from "@/lib/entries";
import { currentEntry, useWriter } from "@/lib/store";

const optionClass =
  "w-full rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent";

export function ChatPopover() {
  const entry = useWriter(currentEntry);
  const [copied, setCopied] = useState<ChatProvider | null>(null);

  const text = entry?.content ?? "";
  const isWelcome = isWelcomeEntry(text);
  const tooShort = text.trim().length < MIN_CHAT_LENGTH;
  const tooLong = !tooShort && isUrlTooLong(text);

  const open = (provider: ChatProvider) => {
    window.open(chatUrl(provider, text), "_blank", "noopener,noreferrer");
  };

  const copy = async (provider: ChatProvider) => {
    await navigator.clipboard.writeText(fullPrompt(provider, text));
    setCopied(provider);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Popover>
      <PopoverTrigger className="text-muted-foreground transition-colors hover:text-foreground">
        Chat
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-64 p-2">
        {isWelcome ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            This is the guide. Write your own entry first, then click Chat.
          </p>
        ) : tooShort ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            Please free write for at minimum 5 minutes first. Then click this.
            Trust.
          </p>
        ) : tooLong ? (
          <div className="flex flex-col gap-1">
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Your entry is too long to send as a link. Copy the prompt and
              paste it into a chat.
            </p>
            <button className={optionClass} onClick={() => copy("chatgpt")}>
              {copied === "chatgpt" ? "Copied" : "Copy ChatGPT prompt"}
            </button>
            <button className={optionClass} onClick={() => copy("claude")}>
              {copied === "claude" ? "Copied" : "Copy Claude prompt"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <button className={optionClass} onClick={() => open("chatgpt")}>
              ChatGPT
            </button>
            <button className={optionClass} onClick={() => open("claude")}>
              Claude
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
