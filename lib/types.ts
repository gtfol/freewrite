export interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: string;
}

export type ExtractSource = "direct" | "archive" | "render";

export type ArticleVia = "archive" | "render" | null;

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
