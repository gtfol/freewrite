# Repository migration

The web app moves from the repository root to `apps/web`, following capsule's combined repository layout. Web source, dependency versions, database migrations, API routes, and browser storage keys are unchanged. Its npm lockfile, Next.js configuration, Vercel configuration, and agent instructions stay with the web app.

## Local setup

Run `npm ci` and app commands from `apps/web`. Git does not move ignored local files: move your existing `.env` or `.env.local` into `apps/web` yourself if needed, and never commit it. Old root-level `node_modules` and `.next` are not used by the moved app.

The PDF asset route reads the app's `node_modules` from its working directory. Next.js tracing and Turbopack aliases remain relative to `apps/web`; do not run the server from the repository root.

## Manual Vercel cutover

These settings must be reviewed by the project owner; this PR does not change the Vercel project.

1. Keep the existing project, Git connection, production branch, domains, and environment variables.
2. Change **Root Directory** from the repository root to **apps/web** before building the migration preview.
3. Keep the **Next.js** framework preset. Standard commands are `npm ci`, `npm run build`, and Next.js's default output. If custom install/build/output overrides exist, make them relative to `apps/web`; do not prefix commands with another `cd apps/web`.
4. If an **Ignored Build Step** or custom configuration-file path is configured, update any root-relative source paths. The Vercel config is now `apps/web/vercel.json`; its `/api/cron/spotify` route and schedule are unchanged.
5. Check the preview's writer, history, reader/PDF assets, and configured sign-in/sync. Then merge and verify the production deployment and cron.

The currently serving deployment remains live during the cutover. Older branches using the root layout cannot build with the new Root Directory. Roll back to a previously built deployment if needed; to rebuild old code, restore the previous Root Directory too.

## Verification

Run in `apps/web`:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run start
```

Install Redis to exercise the isolated sharing integration tests. Account-deletion database tests require the disposable database described in the web README; they must never use production credentials. The existing CSS minifier warnings for `::highlight` are unrelated to this move.

## Local verification record

On September 23, 2026, the original root layout and the moved app both passed the production build and 227 tests (one disposable-Postgres test skipped). The moved app also passed lint and type checking. Existing `::highlight` CSS warnings were present before and after.

The production server from `apps/web` was inspected in a browser: new entry, typing, reload recovery, history, backspace lock, reader, PDF text extraction, saving, and opening the saved PDF text all worked. PDF worker and font routes returned HTTP 200. Sign-in, sync with a real account, Spotify cron execution, and Vercel preview/production deployment still require configured services and the manual cutover above.
