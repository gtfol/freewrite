export interface AppFont {
  id: string;
  label: string;
  stack: string;
}

export const STANDARD_FONTS: AppFont[] = [
  { id: "lato", label: "Lato", stack: "var(--font-lato), sans-serif" },
  { id: "arial", label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { id: "system", label: "System", stack: "ui-sans-serif, system-ui, sans-serif" },
  { id: "serif", label: "Serif", stack: "'Times New Roman', Times, ui-serif, serif" },
];

export const RANDOM_FONTS: AppFont[] = [
  { id: "inter", label: "Inter", stack: "var(--font-inter), sans-serif" },
  { id: "crimson", label: "Crimson Pro", stack: "var(--font-crimson), serif" },
  { id: "garamond", label: "EB Garamond", stack: "var(--font-garamond), serif" },
  { id: "plex-mono", label: "Plex Mono", stack: "var(--font-plex-mono), monospace" },
];

export const ALL_FONTS = [...STANDARD_FONTS, ...RANDOM_FONTS];

export const FONT_SIZES = [16, 18, 20, 22, 24, 26];

export const DEFAULT_FONT_ID = "lato";
export const DEFAULT_FONT_SIZE = 18;

export function fontById(id: string): AppFont {
  return ALL_FONTS.find((font) => font.id === id) ?? STANDARD_FONTS[0];
}

export function randomFont(excludeId: string): AppFont {
  const pool = ALL_FONTS.filter((font) => font.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function nextFontSize(current: number): number {
  const index = FONT_SIZES.indexOf(current);
  return FONT_SIZES[(index + 1) % FONT_SIZES.length];
}
