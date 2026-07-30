import type { Stroke } from "drawesome";

// A drawing made with the / command. Strokes are drawesome's own plain data;
// the board they were sampled against travels with them, because a point only
// means anything relative to it. No timestamps: the entry's updatedAt already
// says when the drawing changed, and a per-sketch clock would differ between
// devices that agree on every stroke.
export interface Sketch {
  id: string;
  w: number;
  h: number;
  /** Paper colour, kept with the drawing so it renders the same everywhere. */
  bg: string;
  strokes: Stroke[];
}

export interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: string;
  // The entry text references these by id — ![sketch](sketch:a3f1) — which is
  // what gives a drawing a place in the prose without putting tens of
  // kilobytes of stroke data in the middle of a sentence. Absent when the
  // entry has no drawings — never an empty array.
  sketches?: Sketch[];
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
}

export interface ManifestItem {
  id: string;
  hash: string;
  rev: number;
}

export interface SyncManifest {
  entries: ManifestItem[];
  articles: ManifestItem[];
}

export interface SyncDigest {
  entries: { digest: string; count: number };
  articles: { digest: string; count: number };
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
