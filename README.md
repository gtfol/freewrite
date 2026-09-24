# freewrite

write for 15 minutes. don't stop. don't edit.

| App | Source | Development |
| --- | --- | --- |
| Web | [apps/web](apps/web) | `cd apps/web && npm ci && npm run dev` |
| iPhone | [apps/ios](apps/ios) | Open `apps/ios/Freewrite.xcodeproj` in Xcode |

The web app includes writing, a reader, and optional sign-in and sync. Everything starts locally in your browser. See the [web README](apps/web/README.md) for setup and feature details.

Apps keep independent build tools and dependencies, following [capsule](https://github.com/gtfol/capsule). There is no root npm install or shared lockfile. The native iPhone app adds local writing and on-device live dictation; see its [README](apps/ios/README.md).

## Checks

From `apps/web`, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. GitHub Actions runs these checks when the web app or its workflow changes.

From `apps/ios`, run `swift test` and `scripts/test-ios.sh`. Xcode 26.6 and an iOS 26+ iPhone simulator are required. GitHub Actions checks the generated project, core tests, simulator tests, and unsigned device build.

## Deployment

The existing Vercel project should deploy `apps/web` to [freewrite.gtfol.dev](https://freewrite.gtfol.dev). Set its Root Directory to `apps/web` by hand when cutting over; retain its Git connection, domains, environment variables, and production branch. The Spotify cron remains in `apps/web/vercel.json`.

See [repository migration](docs/repository-migration.md) for local setup, Vercel settings, verification, and rollback.
