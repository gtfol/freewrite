# freewrite

a web version of [freewrite](https://github.com/farzaa/freewrite) — write for 15 minutes. don't stop. don't edit.

plus a small reader: paste a link, read it clean.

everything is saved locally in your browser. nothing leaves your machine, except the links you ask the reader to fetch.

## dev

```
npm install
npm run dev
```

## listen

saved articles can be read aloud. the word being spoken is highlighted as it goes, and clicking any line jumps the audio there.

speech is generated on your device — kokoro where webgpu is available, piper on cpu where it isn't — so no api key, and the article text never leaves the browser. the voice model is fetched once (huggingface for the weights, a cdn for the wasm runtime) and cached; after that it works offline.

audio is stored per sentence, keyed by a hash of the text, so trimming an article only invalidates the sentences you removed. it's kept as opus in indexeddb, evicted least-recently-played once it outgrows its budget, and deliberately never synced — re-generating on another device is cheaper than shipping megabytes around. `Download` pins an article so eviction leaves it alone.

## sync (optional)

fully local by default. to sync across devices:

1. create a supabase project, run `db/schema.sql` in its sql editor
2. set `DATABASE_URL` (transaction pooler string), `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), and `BETTER_AUTH_URL` (your deployment url)
3. redeploy — a cloud icon appears in the nav

## sharing (optional)

entries can be published as read-only pages (`share` in the nav), and the reader uses the same store for temporary chat snapshots. to enable it:

1. create an upstash redis (or vercel kv) database
2. set `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
3. optional: `SHARE_ENTRY_TTL_SECONDS` — how long entry links live (default 30 days)

links are unlisted (random 128-bit ids), noindexed, and expire on their own. the create/update/delete secret never leaves the author's browser.

## stack

next.js · tailwind · shadcn/ui · zustand · indexeddb · kokoro + piper via onnx runtime web (on-device tts) · better auth + supabase (optional sync)
