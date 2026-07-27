export interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: string;
  deletedAt?: number | null;
}

export type ExtractSource = "direct" | "archive" | "paste";

// "render" only survives as a label for articles saved while the
// r.jina.ai fallback existed.
export type ArticleVia = "archive" | "render" | "paste" | null;

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
  updatedAt: number;
  deletedAt?: number | null;
}

export interface SyncCollectionResult<T> {
  rows: T[];
  cursor: number;
  hasMore: boolean;
}

export interface SyncResponse {
  entries: SyncCollectionResult<Entry>;
  articles: SyncCollectionResult<Article>;
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
