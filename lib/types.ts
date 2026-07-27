export interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: string;
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
  via: "archive" | null;
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
