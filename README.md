# freewrite

write for 15 minutes. don't stop. don't edit.

| App | Source | Development |
| --- | --- | --- |
| Web | [apps/web](apps/web) | `cd apps/web && npm ci && npm run dev` |

The web app includes writing, a reader, and optional sign-in and sync. Everything starts locally in your browser. See the [web README](apps/web/README.md) for setup and feature details.

Apps keep independent build tools and dependencies, following [capsule](https://github.com/gtfol/capsule). There is no root npm install or shared lockfile. A native iPhone app will be added under `apps/ios` separately.

## Checks

From `apps/web`, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. GitHub Actions runs these checks when the web app or its workflow changes.

## Deployment

The existing Vercel project should deploy `apps/web` to [freewrite.gtfol.dev](https://freewrite.gtfol.dev). Set its Root Directory to `apps/web` by hand when cutting over; retain its Git connection, domains, environment variables, and production branch. The Spotify cron remains in `apps/web/vercel.json`.

See [repository migration](docs/repository-migration.md) for local setup, Vercel settings, verification, and rollback.
