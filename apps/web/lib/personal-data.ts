import type { Article, Entry, Sketch } from './types.ts';

export function personalDataExport(data: { entries: Entry[]; articles: Article[]; sketches: Sketch[] }, now = Date.now()) {
  return {
    format: 'freewrite', version: 1, exportedAt: new Date(now).toISOString(),
    entries: data.entries.map(({id, content, createdAt, updatedAt}) => ({id, content, createdAt, updatedAt})),
    articles: data.articles.map(({id, url, title, byline, siteName, excerpt, content, contentOriginal, wordCount, savedAt, readAt, via, highlights, updatedAt}) => ({id, url, title, byline, siteName, excerpt, content, contentOriginal, wordCount, savedAt, readAt, via, highlights, updatedAt})),
    sketches: data.sketches.map(({id, w, h, bg, strokes, updatedAt}) => ({id, w, h, bg, strokes, updatedAt})),
  };
}
