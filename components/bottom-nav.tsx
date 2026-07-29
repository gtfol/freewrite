"use client";

import Link from "next/link";
import { useState } from "react";
import { Clock, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { ChatPopover } from "@/components/chat-popover";
import { FontPopover } from "@/components/font-popover";
import { SharePopover } from "@/components/share-popover";
import { SyncPopover } from "@/components/sync-popover";
import { TimerButton } from "@/components/timer-button";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { type PreviewMode, usePrefs, useTimer, useWriter } from "@/lib/store";
import { cn } from "@/lib/utils";

function NavButton({
  active = false,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "transition-colors hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

function Dot() {
  return <span className="text-muted-foreground/40 select-none">•</span>;
}

// Each click moves one step around the cycle; the tooltip names the next stop.
const PREVIEW_TITLES: Record<PreviewMode, string> = {
  off: "Preview beside the writing",
  split: "Preview on its own",
  full: "Back to writing",
};

export function BottomNav() {
  const backspaceDisabled = usePrefs((s) => s.backspaceDisabled);
  const previewMode = usePrefs((s) => s.previewMode);
  const toggleBackspace = usePrefs((s) => s.toggleBackspace);
  const cyclePreview = usePrefs((s) => s.cyclePreview);

  const running = useTimer((s) => s.running);
  const addEntry = useWriter((s) => s.addEntry);
  const sidebarOpen = useWriter((s) => s.sidebarOpen);
  const setSidebarOpen = useWriter((s) => s.setSidebarOpen);

  const { theme, setTheme } = useTheme();
  const fullscreen = useFullscreen();
  const [hovered, setHovered] = useState(false);

  return (
    <nav
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 bg-background transition-opacity duration-1000",
        running && !hovered ? "opacity-0" : "opacity-100"
      )}
    >
      <div className="mx-auto flex max-w-[1000px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-4 text-[13px]">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <FontPopover />
          <Dot />
          <TimerButton />
          <Dot />
          <ChatPopover />
          <Dot />
          <SharePopover />
          <Dot />
          <Link
            href="/read"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Read
          </Link>
          <Dot />
          <NavButton
            active={backspaceDisabled}
            onClick={toggleBackspace}
            title={
              backspaceDisabled
                ? "Backspace is off — no deleting"
                : "Turn backspace off"
            }
            className={cn(backspaceDisabled && "line-through")}
          >
            Backspace
          </NavButton>
          <Dot />
          <NavButton
            active={previewMode !== "off"}
            onClick={cyclePreview}
            title={PREVIEW_TITLES[previewMode]}
            className={cn(previewMode === "full" && "underline underline-offset-4")}
          >
            Preview
          </NavButton>
          <Dot />
          {fullscreen.supported && (
            <>
              <NavButton onClick={fullscreen.toggle}>
                {fullscreen.active ? "Minimize" : "Fullscreen"}
              </NavButton>
              <Dot />
            </>
          )}
          <NavButton onClick={addEntry}>New Entry</NavButton>
          <Dot />
          <NavButton
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
            className="flex items-center"
          >
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </NavButton>
          <SyncPopover />
          <NavButton
            active={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="History"
            className="flex items-center"
          >
            <Clock className="size-4" />
          </NavButton>
        </div>
      </div>
    </nav>
  );
}
