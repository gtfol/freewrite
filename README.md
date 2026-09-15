# freewrite

a web version of [freewrite](https://github.com/farzaa/freewrite) — write for 15 minutes. don't stop. don't edit.

plus a small reader: paste a link or choose a PDF, read it clean.

everything is saved locally in your browser. syncing, sharing, and fetching article links send data only when you choose those features.

## dev

```
npm install
npm run dev
```

`npm test` runs the test suite. install `redis-server` and `redis-cli` to include the isolated share-store integration tests; those tests skip when Redis is unavailable.

## local PDFs

in Read, choose a PDF or drop one onto the import area. PDF.js extracts its text in your browser; edit the title and text preview, then save. progress and cancel are available while extracting. saved text works with Listen, highlights, and Trim.

imports accept selectable-text PDFs up to 20 MB, 300 pages, and 250,000 text characters. scanned PDFs need text recognition in another app first; password-protected files need an unlocked copy. columns and tables may need editing in the preview.

the original PDF stays in IndexedDB on the importing device, where **Original** opens it. optional sync transfers the extracted text and article metadata, not the file; other devices can read and listen without the original. deleting the article also removes its local original. PDF.js worker and font assets are served by this app, with no document uploads to an extraction service. no new SQL migration or environment variables are needed.

## listen

saved articles can be read aloud. the word being spoken is highlighted as it goes, and clicking any line jumps the audio there.

speech is generated on your device by piper, so no api key, and the article text never leaves the browser. the voice model is fetched once (~60mb, huggingface for the weights and a cdn for the wasm runtime) and cached in opfs; after that it works offline.

audio is stored per sentence, keyed by a hash of the text, so trimming an article only invalidates the sentences you removed. it's kept as opus in indexeddb, evicted least-recently-played once it outgrows its budget, and deliberately never synced — re-generating on another device is cheaper than shipping megabytes around. `Download` pins an article so eviction leaves it alone.

## sync (optional)

fully local by default. to sync across devices:

1. create a supabase project, run `db/schema.sql` in its sql editor
2. set `DATABASE_URL` (transaction pooler string), `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), and `BETTER_AUTH_URL` (your deployment url)
3. download the database CA certificate from supabase's **Database → Settings → SSL Configuration** and set `DATABASE_SSL_CA` to the entire certificate text, including the `BEGIN CERTIFICATE` and `END CERTIFICATE` lines. actual line breaks and literal `\n` escapes both work. set this in vercel before deploying the app
4. redeploy — a cloud icon appears in the nav

remote database connections verify the server's certificate and hostname. `DATABASE_SSL_CA` supplies supabase's trusted root; databases using a publicly trusted certificate can leave it unset. connection URL query options such as `sslmode=require` cannot override verification. only the exact loopback hosts `localhost`, `127.0.0.1`, and `::1` use an unencrypted connection for local development.

## sharing (optional)

entries can be published as read-only pages (`share` in the nav), and the reader uses the same store for temporary chat snapshots. to enable it:

1. create an upstash redis (or vercel kv) database
2. set `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
entry links default to **7 days**. the Share popover offers **7 days**, **30 days**, and **Never**. choose an expiry when creating a link, or use **Save expiry** on an existing link. expiry changes preserve the published snapshot; **Update link** publishes the current entry while preserving its remaining lifetime. existing links keep their current expiry until explicitly changed. the former `SHARE_ENTRY_TTL_SECONDS` setting is no longer used.

links are unlisted (random 128-bit ids) and noindexed. timed snapshots are removed by Redis expiry. Never links remain until the author deletes them (or the backing store is removed); changing a timed link to Never removes its Redis TTL. small permanent ID/owner-hash markers prevent a delayed request from recreating an expired or revoked link; these markers contain no entry content. no database migration or new environment variable is required.

the management token is kept in the author's browser and sent only to the server when updating or deleting that link; it is never included in the public URL or page. clearing browser data loses those controls. IDs and management tokens are saved before publication, so a lost response can be retried without losing control of the link. **Check link** recovers its actual expiry after an uncertain change. expired-looking local records keep their controls until the server confirms they are gone. browser Web Locks serialize management across tabs; storage failures are reported, with a retry/delete path. deleting a shared entry first revokes its link; if that fails, the entry and its controls stay available for another attempt.

the reader's temporary chat snapshots are separate: they still expire after 30 minutes by default (`SHARE_TTL_SECONDS`, 60 seconds to 24 hours). changing entry-link expiry does not affect them.

## song of the day (optional)

if you use the writer as a daily journal, typing `/` offers the song you played most on the day the entry was written — write up sunday on monday morning and you still get sunday's song. needs sync turned on first — spotify hangs off your account.

1. create an app in the [spotify dashboard](https://developer.spotify.com/dashboard)
2. add `<your url>/api/auth/callback/spotify` as a redirect uri. locally that's `http://127.0.0.1:3000/api/auth/callback/spotify` — spotify rejects `localhost`, so visit the app on `127.0.0.1` too and set `BETTER_AUTH_URL` to match
3. set `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`
4. set `CRON_SECRET` (`openssl rand -base64 32`) — vercel sends it to the poller below, which refuses to run without it
5. redeploy, sign in, then `Connect Spotify` in the cloud menu

spotify only ever attaches to an account you already have: it can't create one and it can't sign you in. the one scope asked for is `user-read-recently-played`, and the token stays on the server — the browser only ever sees a track name and an id.

the song lands in your entry as an ordinary markdown link (`[♫ title · artist](…)`), so it reads fine while you write, downloads with the entry, and syncs like any other text. in Preview it renders as a small card; click the card and spotify's player takes its place, so nothing loads from spotify until you ask it to.

worth knowing: spotify's play history is the last 50 plays and can't be paged past — there is no endpoint for "what did i play on the 3rd", and top-tracks bottoms out at about four weeks. fifty plays is roughly three hours of listening, so on the api alone yesterday is usually already gone.

so the deployment keeps its own record instead, which is what every app with real history does (stats.fm, last.fm). `vercel.json` schedules `/api/cron/spotify` every half hour; it reads each connected account's window and appends it to `spotify_plays`, and consecutive polls overlap heavily by design — `(user_id, played_at)` is the primary key, so the repeats collapse. asking for a song also records what it sees, which covers the gap between polls and gets a brand-new connection's first plays in without waiting.

the record starts the day you connect. before that there is nothing to read, and the menu says the day is from before your listening was recorded rather than claiming you played nothing — "we can't know" and "nothing" are different answers and it never conflates them. on a quiet day everything has a single play and you get the most recent one.

the cron needs a plan with sub-daily schedules (vercel hobby caps cron at once a day; pro does per-minute). on hobby, either drop it to `0 0 * * *` and accept a daily snapshot, or point an external scheduler at the same route with the same `CRON_SECRET` bearer token.

## whiteboard

typing `/` also offers a whiteboard. it opens full screen — writing and drawing are different states of mind, and drawing wants the room — with seven pens and an eraser from [drawesome](https://benji.org/drawesome). there is nothing to configure and nothing to sign into.

it saves as you draw, one save per stroke, the same as typing does. `Esc` goes back. close it without drawing anything and the entry is exactly as you left it.

the sheet is dark if you asked for it from a dark app and light if you didn't, and it keeps that paper for good — the pen is chosen to suit the paper rather than the theme, so a drawing can't end up as pale ink on a pale sheet, and it looks the same later wherever it's read. in the prose it's shown cropped to what you actually drew, not to the whole sheet; open it again and the whole sheet is still there with your marks where you left them.

a drawing is a record of its own, and the text keeps a short reference to it (`![sketch](sketch:a3f1)`). strokes are tens of kilobytes of coordinates, which is the one thing that can't sit in the middle of a sentence you're still writing — so the line you see while writing stays a line. in Preview it renders as a figure; click it to open the board again. put the caret after a drawing's line and type `/` to reopen that one without Preview on.

the reference is resolved wherever it's written, not against the entry that made it, so a drawing isn't owned by one entry and doesn't die with a moment's state of the text. delete the reference while you rewrite the paragraph around it and the drawing is still there when you put it back. a drawing nothing points at is noted on load and let go a month later, if nothing has claimed it by then.

copying a drawing's reference into another entry shows the same drawing in both, and drawing on it changes it in both — it is one drawing, in two places.

a downloaded entry is one markdown file with nowhere to keep a stroke list, so each drawing is embedded as an svg image instead. the file stops being editable as a drawing and starts being readable in anything that renders markdown.

if you sync, apply `db/migrations/0005_sketches.sql` — drawings are their own table. (`0004` added a column on `entries` that `0005` supersedes; applying both in order is fine.)

## stack

next.js · tailwind · shadcn/ui · zustand · indexeddb · drawesome (drawing) · piper via onnx runtime web (on-device tts) · better auth + supabase (optional sync)

### Settings and support

Settings is available from the gear in both writing and reading navigation at `/settings`.
It exports this browser's entries, drawings, articles, highlights and original PDFs as
versioned JSON (PDF bytes are base64). Generated audio, credentials and share-management
secrets are excluded. This is an export format, not an in-app restore/import flow.

Guests can clear browser data; signed-in users can delete their account and synced data
as well. Both require typing `DELETE` and revoke share links managed in this browser
before clearing local data. Links managed only on other devices are independent browser
capabilities and must be removed there. Other devices' offline copies are not remotely
erased. Voice models can be removed separately in Audio storage. IndexedDB generation
checks prevent older open tabs from writing stale content after a local reset.

The navigation heart opens the separate, live [Support Freewrite checkout](https://buy.stripe.com/bJeaEY2jG3ZF1gKbezenS04):
one-time support, with an editable $5 USD preset. The public URL is in
`components/support-link.tsx`; no Stripe credentials, webhooks or subscription backend
are needed. Forks should replace or remove this link.

Account deletion integration tests can run against a disposable local database named
`freewrite_settings_test`, using `FREEWRITE_TEST_DATABASE_URL`. The test truncates that
local database's user records and never uses `DATABASE_URL`.
