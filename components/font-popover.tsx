"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fontById, FONT_SIZES, randomFont, STANDARD_FONTS } from "@/lib/fonts";
import { usePrefs } from "@/lib/store";
import { cn } from "@/lib/utils";

export function FontPopover() {
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const setFont = usePrefs((s) => s.setFont);
  const setFontSize = usePrefs((s) => s.setFontSize);

  const currentFont = fontById(fontId);
  const isRandomFont = !STANDARD_FONTS.some((f) => f.id === fontId);

  return (
    <Popover>
      <PopoverTrigger
        className="text-muted-foreground transition-colors hover:text-foreground"
        title="Font & size"
      >
        <span className="text-[11px]">a</span>
        <span className="text-[15px]">A</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-56 p-2">
        <p className="px-3 pt-1 pb-2 text-xs text-muted-foreground">Size</p>
        <div className="flex gap-1 px-3 pb-2">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              onClick={() => setFontSize(size)}
              className={cn(
                "flex-1 rounded-md py-1 text-sm transition-colors hover:bg-accent",
                size === fontSize
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {size}
            </button>
          ))}
        </div>
        <div className="my-1 h-px bg-border" />
        <p className="px-3 pt-1 pb-1 text-xs text-muted-foreground">Font</p>
        {STANDARD_FONTS.map((font) => (
          <button
            key={font.id}
            onClick={() => setFont(font.id)}
            style={{ fontFamily: font.stack }}
            className={cn(
              "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
              fontId === font.id ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {font.label}
          </button>
        ))}
        <button
          onClick={() => setFont(randomFont(fontId).id)}
          className={cn(
            "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
            isRandomFont ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {isRandomFont ? `Random [${currentFont.label}]` : "Random"}
        </button>
      </PopoverContent>
    </Popover>
  );
}
