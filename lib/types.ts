import type { Stroke } from "drawesome";

/**
 * A drawing made with the / command. Strokes are drawesome's own plain data;
 * the board they were sampled against travels with them, because a point only
 * means anything relative to it.
 *
 * A record of its own rather than a field on the entry, and resolved by the
 * reference in a text — ![sketch](sketch:a3f1) — wherever that reference ends
 * up. That is what lets a drawing be copied from one entry to another, and it
 * means a drawing's life doesn't hang on the text saying so at this instant:
 * delete the reference while you rewrite the paragraph around it and the
 * drawing is still here when you put it back.
 */
export interface Sketch {
  id: string;
  w: number;
  h: number;
  /** Paper colour, kept with the drawing so it renders the same everywhere. */
  bg: string;
  strokes: Stroke[];
  updatedAt: number;
  /**
   * When this drawing was first noticed with nothing pointing at it. Set by the
   * sweep, cleared if a reference comes back, and the clock the grace period is
   * measured from — a drawing is only collected once it has been unclaimed for
   * that long, so deleting a reference while rewriting the text around it can't
   * take the drawing with it.
   *
   * Deliberately outside the hash: it's this device's bookkeeping, not part of
   * the drawing, so noticing an orphan doesn't push a record or disagree with
   * another device that hasn't noticed yet.
   */
  orphanedAt?: number | null;
  deletedAt?: number | null;
}

export interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: string;
  deletedAt?: number | null;
}

export type ExtractSource = "direct" | "render" | "paste";

// "archive" and "freedium" only survive as labels for articles saved while
// those fallbacks existed; nothing produces them now.
export type ArticleVia = "archive" | "render" | "paste" | "freedium" | null;

// A reader annotation: the exact quoted text plus a little surrounding
// context (a text-quote anchor, re-anchored against the rendered article at
// view time) and an optional attached comment.
export interface Highlight {
  id: string;
  text: string;
  prefix: string;
  suffix: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Article {
  id: string;
  url: string;
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  content: string;
  wordCount: number;
  savedAt: number;
  readAt: number | null;
  via: ArticleVia;
  // Set on first trim; content as it was before any blocks were removed.
  contentOriginal?: string;
  // Absent when the article has no annotations — never an empty array.
  highlights?: Highlight[];
  updatedAt: number;
  deletedAt?: number | null;
}

// A synced record travels with its server revision (the global seq at the
// time of its last accepted write) and its content hash.
export interface SyncRow<T> {
  record: T;
  rev: number;
  hash: string;
}

export interface SyncChange<T> {
  record: T;
  // Server revision this edit was based on; 0 = client believes it's new.
  baseRev: number;
  hash: string;
}

export type PushOutcome<T> =
  | { id: string; status: "ok"; rev: number; hash: string }
  | { id: string; status: "conflict"; server: SyncRow<T> };

export interface SyncCollectionResult<T> {
  results: PushOutcome<T>[];
  rows: SyncRow<T>[];
  cursor: number;
  hasMore: boolean;
}

export interface SyncResponse {
  entries: SyncCollectionResult<Entry>;
  articles: SyncCollectionResult<Article>;
  sketches: SyncCollectionResult<Sketch>;
}

export interface ManifestItem {
  id: string;
  hash: string;
  rev: number;
}

export interface SyncManifest {
  entries: ManifestItem[];
  articles: ManifestItem[];
  sketches: ManifestItem[];
}

export interface SyncDigest {
  entries: { digest: string; count: number };
  articles: { digest: string; count: number };
  sketches: { digest: string; count: number };
}

export interface ExtractedArticle {
  url: string;
  title: string;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  content: string;
  wordCount: number;
}
