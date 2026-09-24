# Verification

Verified September 23, 2026 with Xcode 26.6 (17F113), Swift 6.3.3, and the iOS 26.5 iPhone 17 Pro simulator. A signed Release build was also installed successfully on an iPhone 14 Pro running iOS 26.6.1. The owner confirmed that build 2's live dictation works and keeps the transcript after Stop. Extended interruption checks remain pending.

## Automated checks

- `swift test`: 19 tests passed after removing the four obsolete remote-cleanup tests.
- `FREEWRITE_DERIVED_DATA=/private/tmp/freewrite-release-tests-20260923 scripts/test-ios.sh`: 25 simulator tests passed after removing obsolete remote-cleanup tests; Debug simulator and unsigned Release device builds succeeded without warnings.
- Regenerating `Freewrite.xcodeproj` is deterministic. Swift 6 strict concurrency and warnings-as-errors are enabled.
- Cleaner checks cover fillers, meaningful “like,” retained words, paragraphs, Unicode, punctuation, and bypassing English rules for other locales. Cleanup has no network implementation.
- Entry checks cover the web JSON shape, Unix millisecond dates, null/missing deletion dates, SwiftData reopen, and tombstones. The retired-key migration check uses a separate temporary Keychain service and removes its test values.
- Writer checks cover finalized-text checkpoints before Stop, saving provisional words while still recording, cleanup failure, interruption, insertion at a Unicode cursor, surrounding edits, overlapping edits, late cleanup, save failure/retry, and backspace lock.
- UIKit checks exercise the native undo manager restoring raw dictation and verify typing publishes only after UIKit commits the edit. This prevents SwiftUI redraws from disturbing in-flight insertion.
- The audio callback regression test constructs the production tap on MainActor and invokes it on a detached task with synthetic 48 kHz stereo audio. Conversion produces a 16 kHz mono analyzer input without an actor-isolation trap.

## First device test and correction

The first iPhone microphone attempt crashed as recording began after the model download. The device crash report (`Freewrite-2026-09-23-202037.ips`) shows `_dispatch_assert_queue_fail` through Swift's executor check on `RealtimeMessenger.mServiceQueue`, called by `AVAudioNodeTap`. The tap closure had inherited MainActor from setup even though AVAudioEngine calls it off-actor.

Build 2 creates that callback in the nonisolated audio bridge with an explicit `@Sendable` function type. It passed the 29-test simulator suite and installed on the same physical phone. The owner repeated the microphone test and confirmed the app stays open, transcribes speech, and retains the text after Stop. The build also uploaded successfully for internal TestFlight testing.

The next microphone attempt exposed a separate reservation bug: `AssetInventory.reserve(locale:)` returns false when a locale is already reserved, and `reservedLocales` may return locale variants. Build 3 removes that manual check and lets `assetInstallationRequest(supporting:)` manage reservations and reuse installed assets. Repeat-recording confirmation is pending.

## Simulator walkthrough

Used a separate fresh simulator named “iPhone freewrite verification.” Typed synthetic text into the actual app, opened history, resumed the entry, started/paused the timer, and enabled backspace lock. A delete key left locked text intact. Force-terminated and relaunched the app after a checkpoint; the text returned unchanged.

Inspected the white and black system appearances, Settings, the writing toolbar, and the largest accessibility text size. The editor scrolls and the microphone error and Settings action remain readable at that size. Permission denial was produced using the simulator's real microphone permission state, then tapping Dictate in the app; no mock error screen or screenshot compositing was used.

| Write, light | Write, dark | Microphone denied |
| --- | --- | --- |
| ![Light writing screen](screenshots/write-light.png) | ![Dark writing screen](screenshots/write-dark.png) | ![Microphone access denied](screenshots/microphone-denied.png) |

The simulator checks verify the editor, persistence, and error presentation. They do **not** establish speech recognition accuracy, actual model installation, live audio routing, or real-device interruption behavior.

## Physical iPhone checklist

- [x] Register `dev.gtfol.freewrite` under gtfol, LLC, create a signed Release archive, and install it on the connected iPhone 14 Pro.
- [x] Verify SpeechTranscriber hardware/language availability on the installed physical iPhone: live transcription confirmed by the owner on build 2.
- [ ] On first use, allow the microphone and watch model download progress. Cancel during installation; retry, including after a failed/offline download.
- [ ] After model installation, dictate in airplane mode. Verify live interim corrections, finalized phrases without duplicates, pauses, long continuous speech, and the last words arriving after Stop.
- [ ] Compare built-in mic and Bluetooth input in quiet/noisy surroundings. Confirm the audio engine stops when the user taps Stop.
- [ ] Place the caret before/inside/after existing text, including emoji and multiple paragraphs. Dictate, edit surrounding text, stop, and undo cleanup once. Existing text must remain intact.
- [ ] Exercise call, Siri, route removal/change, and audio-service reset where possible. Available text must remain saved; recording must require an explicit new tap.
- [ ] Background and lock the phone while dictating. Recording must stop; returning must show the interruption and retain available text. Background recording is intentionally absent.
- [ ] Force-terminate mid-dictation and relaunch. Expect the last successful text checkpoint, potentially losing the latest unsaved or unrecognized words. There is intentionally no recoverable audio file.
- [ ] Deny/revoke microphone access, reopen Settings, and retry after granting it. Check unsupported language/device messages and that typing remains available.
- [ ] Check VoiceOver, software keyboard, hardware-keyboard undo, dictation with the keyboard visible, landscape, and Dynamic Type on a smaller physical iPhone.

## Future reader behavior

The reader is outside this write-and-dictate slice. When it reaches iOS, imported content must support direct text editing and trimming within paragraphs, with undo, cancel, and restoration of the original import, matching the separate web reader edit PR. Writing-only slash commands are excluded.

## Account login test build, September 24

Build 5 adds system-browser sign-in with the same web account, secure device-only Keychain storage, sign-out with server revocation, and typed confirmation for account deletion. Entries remain local; account sign-in does not yet enable entry sync.

- 28 core tests pass, including PKCE's RFC challenge vector, strict callback validation, cancellation, credential-storage failure, offline sign-out retry, session expiration, and matching the deletion confirmation to the account.
- 35 iOS simulator tests pass, including a real Keychain credential round trip and removal with a unique test service. Debug simulator and Release device builds pass.
- 240 web tests pass, with one existing optional database test skipped. Native account tests cover origin checks, account mismatch, incorrect PKCE proof, authorization-code replay, revoked browser sessions, expired native sessions, session-specific revocation, deletion confirmation, and request size limits. Web lint, type checking, and production build pass.
- The signed Release archive succeeds. Upload was attempted but Xcode could not read the Apple account credential while the Mac was locked. TestFlight distribution, visual review, and a real browser sign-in on an iPhone remain pending; automated checks do not establish those results.
