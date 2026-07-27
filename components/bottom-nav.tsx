"use client";

import Link from "next/link";
import { useState } from "react";
import { Clock, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { ChatPopover } from "@/components/chat-popover";
import { TimerButton } from "@/components/timer-button";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { fontById, randomFont, STANDARD_FONTS } from "@/lib/fonts";
import { usePrefs, useTimer, useWriter } from "@/lib/store";
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

export function BottomNav() {
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const backspaceDisabled = usePrefs((s) => s.backspaceDisabled);
  const setFont = usePrefs((s) => s.setFont);
  const cycleFontSize = usePrefs((s) => s.cycleFontSize);
  const toggleBackspace = usePrefs((s) => s.toggleBackspace);

  const running = useTimer((s) => s.running);
  const addEntry = useWriter((s) => s.addEntry);
  const sidebarOpen = useWriter((s) => s.sidebarOpen);
  const setSidebarOpen = useWriter((s) => s.setSidebarOpen);

  const { theme, setTheme } = useTheme();
  const fullscreen = useFullscreen();
  const [hovered, setHovered] = useState(false);

  const currentFont = fontById(fontId);
  const isRandomFont = !STANDARD_FONTS.some((f) => f.id === fontId);

  return (
    <nav
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 bg-background transition-opacity duration-1000",
        running && !hovered ? "opacity-0" : "opacity-100"
      )}
    >
      <div className="mx-auto flex max-w-[1000px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-4 text-[13px] md:justify-between">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <NavButton onClick={cycleFontSize} title="Font size">
            {fontSize}px
          </NavButton>
          <Dot />
          {STANDARD_FONTS.map((font) => (
            <NavButton
              key={font.id}
              active={fontId === font.id}
              onClick={() => setFont(font.id)}
            >
              {font.label}
            </NavButton>
          ))}
          <NavButton
            active={isRandomFont}
            onClick={() => setFont(randomFont(fontId).id)}
            title="Random font"
          >
            {isRandomFont ? `Random [${currentFont.label}]` : "Random"}
          </NavButton>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <TimerButton />
          <Dot />
          <ChatPopover />
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
