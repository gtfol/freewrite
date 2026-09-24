# freewrite

write for 15 minutes. don't stop. don't edit. now you can talk, too.

Native SwiftUI + SwiftData, iOS 26+, iPhone only. Uses the official PostHog SDK for optional usage analytics; no background recording. Only the public write-only project token is bundled, never a personal API key. The bundle ID is `dev.gtfol.freewrite`, registered to gtfol, LLC (team `J59ZSG67SJ`).

## Build and run

Open `Freewrite.xcodeproj` in Xcode 26.6 or newer and select the **Freewrite** scheme and an iPhone simulator. The complete project is committed; no generation step or package installation is needed to build.

Device signing uses the gtfol, LLC team. Contributors can override the development team locally when building. Both SpeechAnalyzer and SpeechTranscriber require iOS 26. Check a physical device for speech-model support; a compatible OS alone does not guarantee supported hardware or language.

## TestFlight

With the gtfol Apple account signed in to Xcode, `scripts/archive-ios.sh` creates a signed Release archive in a temporary directory. `scripts/archive-ios.sh --upload` also uploads it for **internal TestFlight testing only**; it cannot publish to the App Store or external testers. `FREEWRITE_RELEASE_DIR` changes the output directory, and `FREEWRITE_TEAM_ID` overrides signing.

Create the matching App Store Connect record before uploading. Before each new uploaded build, increment `CURRENT_PROJECT_VERSION` in `scripts/generate-project.py` and regenerate the committed project. The script does not silently change version numbers. Apple may take time to process uploads before testers can install them.

The bundled privacy manifest declares app-only UserDefaults access and account name, email, and user ID used for app functionality without tracking. The encryption declaration covers the app's use of Apple's built-in security and HTTPS APIs. Use `https://gtfol.dev/contact` for the App Store support URL. The iPhone privacy policy is `/ios/privacy` on freewrite.gtfol.dev.

## Write and dictate

The centered app name is flanked by Settings on the left and writing tools on the right. The tools menu inserts Markdown headings, emphasis, links, lists, checklists, quotes, code blocks, and dividers at the selection. Backspace locking still protects existing text.

The bottom toolbar contains the 15-minute timer, microphone, new entry, and history. Tap the timer to start/pause; long-press it to reset. It uses a deadline so elapsed time stays correct when the app is inactive. Finishing resets the timer, as on web, and keeps the text. Backspace locking is optional and off by default, matching web; enable it in Settings. Typed text has autocorrection and spellcheck disabled.

Tap the microphone to start. Live interim words appear at the cursor and are revised in place until Apple finalizes them. Tap again to stop and clean up that dictated passage. **undo cleanup** (or the editor's native undo) restores the exact raw transcript in one action, including when backspace is locked. Selecting existing text before dictation inserts after the selection without deleting it.

Finalized segments save immediately. The visible draft, including interim text, saves at most 500 ms after the first pending change; continued speech does not postpone that save. Raw text is saved before cleanup starts. After a crash, reopening restores the last successful text checkpoint. The most recent unsaved words can be lost, and interim words may not yet be accurate. Audio has no recovery copy because it never goes to disk.

Cleanup runs after stopping and does not gate saving. Edits outside the dictated passage move its anchor; editing inside it or changing entries cancels outstanding work. Late results cannot overwrite another entry or newer manual edits. Calls, Siri, audio-route changes, and backgrounding stop recording, keep available text, and require an explicit tap to resume. Save failures remain visible and prevent switching away from unsaved text until retry succeeds.

## On-device speech and cleanup

The app uses **SpeechAnalyzer + SpeechTranscriber**, fed with in-memory AVAudioEngine buffers. It does not use SFSpeechRecognizer, cloud transcription, or an audio-file recorder. A bounded buffer stops with a visible error if transcription cannot keep up rather than silently dropping audio or growing indefinitely.

Microphone permission is requested when dictation is first used. Apple's separate server-based speech permission does not apply to this API. Model installation shows progress and can be cancelled; unsupported hardware/language and failed downloads leave typing available. Models need a connection to download but transcription runs on device once available. The system locale selects the speech language.

Cleanup uses conservative English rules: obvious “um”/“uh”/“erm” fillers, unambiguous filler “like,” capitalization, and punctuation. Meaningful or ambiguous “like” stays. It is deliberately limited, not a semantic rewrite engine. Other languages retain the speech framework's transcript without English cleanup rules.

## Settings

Short information popovers explain dictation and backspace locking. Dictation and cleanup are entirely on-device; builds 1–2's optional remote cleanup implementation and key entry have been removed. Upgrading deletes that retired Keychain credential.

Settings offers browser sign-in with the existing web account, opening freewrite on the web, sign-out, and confirmed account deletion. This login test build keeps entries local; signing in or out does not upload, reassign, or erase them. Sign-out revokes only this iPhone session. Account deletion removes the web account and its cloud data, with a typed confirmation that explains local writing remains.

Settings links to terms of service, the privacy policy, and “contact us.” “Support freewrite” opens the same Stripe checkout as the web app. This external-payment link is shown only when StoreKit reports the US storefront, following [App Review 3.1.1(a)](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase). Unknown or other storefronts hide the payment link; the contact and legal links remain available.

## Data and design

SwiftData stores entries locally with the web fields `{id, content, createdAt, updatedAt, deletedAt}`. Dates encode as Unix milliseconds, IDs are strings, and deletion produces a tombstone. CloudKit is disabled. The OS may include local entries in device backups; entry sync is not included yet. Account sign-in uses a separate credential in this device’s Keychain.

The interface follows [gtfol's design standard](https://github.com/gtfol/ai/blob/main/DESIGN.md): system light/dark appearance, white/black canvas, monochrome text and line icons, open space, thin dividers, and a quiet bottom toolbar. [Lato Regular](Freewrite/Resources/Lato-Regular.ttf) is bundled under the [OFL](Freewrite/Resources/Lato-OFL.txt), with Dynamic Type.

## Tests and layout

From this directory:

```sh
swift test
scripts/test-ios.sh
```

The script builds the simulator and unsigned Release device targets, then runs tests with ad-hoc simulator signing so Keychain works. It selects an available iPhone simulator running iOS 26 or newer. Each run writes a unique `TestResults-*.xcresult`. To build from an iCloud/file-provider folder, set `FREEWRITE_DERIVED_DATA` to a local temporary path outside that folder so signing is not affected by Finder metadata.

- `Freewrite/Core`: Entry, speech adapter, cleaner, cursor insertion, writing session, and retired-credential cleanup.
- `Freewrite/Persistence`: SwiftData model and explicit-save adapter.
- `Freewrite/UI`: writing, history, settings, and the UIKit editor bridge.
- `FreewriteTests`: core behavior, background audio callbacks, persistence, and retired-credential removal.
- `scripts/generate-project.py`: standard-library-only generator; commit its `.xcodeproj` output.

Only `Transcriber`, `TextCleaner`, and `EntryStore` are extension seams. Entry sync, reader, sharing, background capture, Siri/Shortcuts, driving mode, and other platforms are outside v1.

See [verification](docs/verification.md) for simulator results, screenshots, and the physical-iPhone checklist.

References: [Apple speech results](https://developer.apple.com/documentation/speech/speechtranscriber/result), [speech permissions](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition).

## Account protocol

The app uses ASWebAuthenticationSession with an S256 PKCE challenge and random state. The fixed callback `dev.gtfol.freewrite://auth/callback` carries a single-use, two-minute code, never a session token. The server checks the browser session and explicit account choice before issuing a code; exchange verifies the PKCE proof and original browser session in a database transaction. Only hashes of codes and native bearer tokens are stored. The existing Better Auth verification/session tables and user deletion cascade are reused; this feature needs no schema migration. Native tokens expire after 90 days and are accepted only by `/api/ios/*`, not as website cookies.

The native network client uses an ephemeral session with no cookie or credential storage and rejects redirects. Keychain credentials use `WhenUnlockedThisDeviceOnly`. Cancelling sign-in leaves the writing unchanged. Failed credential storage revokes the newly issued session; failed offline sign-out retains the credential so revocation can be retried.

## Usage analytics

Both platforms use the `freewrite` PostHog project (626171, US). Native analytics runs only in Release builds on physical devices, never Debug, simulator, or unit tests. A closed event enum and a before-send property allowlist exclude user content, account IDs, names, email, screen names, and freeform errors. No identify calls, session replay, swizzling, automatic interaction capture, surveys, error capture, or feature-flag requests. Settings includes a persistent opt-out. Only random installation/session IDs and numeric app/SDK versions accompany explicit usage events.

PostHog is pinned to 3.81.0 through the project generator. Regenerate the Xcode project after changing dependencies; commit its Package.resolved.
