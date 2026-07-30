import { sketchFields } from "@/lib/sketch";
import type { Article, Entry } from "@/lib/types";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// Hashes cover the mutable, meaningful fields only. Identity timestamps and
// updatedAt stay out so identical content hashes identically on every device,
// and read-state hashes as a boolean so wall-clock differences don't diverge.
export function entryHash(e: Entry): Promise<string> {
  const fields: unknown[] = [e.content, e.deletedAt ? 1 : 0];
  // Appended only when drawings exist, so shipping the feature doesn't change
  // the hash of — and re-push — every already-synced entry.
  if (e.sketches?.length) {
    fields.push(e.sketches.map(sketchFields));
  }
  return sha256Hex(JSON.stringify(fields));
}

export function articleHash(a: Article): Promise<string> {
  const fields: unknown[] = [
    a.url,
    a.title,
    a.byline,
    a.siteName,
    a.excerpt,
    a.content,
    a.contentOriginal ?? null,
    a.wordCount,
    a.readAt ? 1 : 0,
    a.via,
    a.deletedAt ? 1 : 0,
  ];
  // Appended only when highlights exist, so shipping the feature doesn't
  // change the hash of — and re-push — every already-synced article.
  if (a.highlights?.length) {
    fields.push(
      a.highlights.map((h) => [h.id, h.text, h.prefix, h.suffix, h.note])
    );
  }
  return sha256Hex(JSON.stringify(fields));
}

export function rootDigest(
  pairs: { id: string; hash: string }[]
): Promise<string> {
  const canonical = pairs
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${p.hash}`)
    .join("\n");
  return sha256Hex(canonical);
}
