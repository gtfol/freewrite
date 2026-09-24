import assert from "node:assert/strict";
import { test } from "node:test";
import { articlePromptLink, articlePromptShared } from "./chat.ts";

test("local PDFs never claim their missing source URL is a readable public link", () => {
  const pdf = { title: "Local PDF", byline: null, url: "", text: "Document text" };
  assert.match(articlePromptLink(pdf), /saved locally/);
  assert.doesNotMatch(articlePromptLink(pdf), /full text is at the link/);
  assert.doesNotMatch(articlePromptShared(pdf, "https://example.com/share", 10), /url above it is the original/);
  assert.match(articlePromptShared({ ...pdf, url: "https://example.com/source" }, "https://example.com/share", 10), /original source/);
});
