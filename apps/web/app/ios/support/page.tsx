import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "iPhone support · freewrite" };

export default function IOSSupportPage() {
  return (
    <main className="mx-auto max-w-[650px] px-6 py-14 text-sm leading-7">
      <Link href="/" className="text-muted-foreground">freewrite</Link>
      <h1 className="mt-8 text-2xl">iPhone support</h1>
      <div className="mt-8 space-y-6">
        <section>
          <h2 className="text-base">Write or dictate</h2>
          <p>Start writing, or tap the microphone to dictate at the cursor. Tap again to stop. The timer starts a 15-minute session; history opens your saved entries. In Settings, you can optionally lock backspace or enable cleanup with your own OpenAI key.</p>
        </section>
        <section>
          <h2 className="text-base">If dictation is unavailable</h2>
          <p>The app requires iOS 26 or later. Dictation also requires a supported device and language. Allow microphone access when prompted, and connect to the internet for the first speech-model download. Once that model is available, transcription runs on the iPhone.</p>
          <p>If permission was denied, use “open Settings” in the app to allow microphone access. A failed model download can be retried. Typing remains available even when dictation is unavailable.</p>
        </section>
        <section>
          <h2 className="text-base">Interruptions and recovery</h2>
          <p>Calls, audio-route changes, and backgrounding stop recording. Return to the app and tap the microphone to start again. Available transcript text is kept; recording never resumes by itself.</p>
          <p>Words save during dictation. If the app closes unexpectedly, reopen it to recover the last saved text. There is no audio backup. If a save error appears, use “retry save” before leaving the entry.</p>
        </section>
        <section>
          <h2 className="text-base">Cleanup and undo</h2>
          <p>After dictation, “undo cleanup” restores the original transcript. If optional OpenAI cleanup fails, your raw text remains. Check connectivity and your own API account, or remove the key in Settings to return to on-device cleanup.</p>
        </section>
        <section>
          <h2 className="text-base">Contact</h2>
          <p><a href="https://gtfol.dev/contact" className="underline underline-offset-4">Contact gtfol</a> with your iPhone model, iOS version, and a description of the problem. Please do not send API keys or private entries.</p>
        </section>
      </div>
      <Link href="/ios/privacy" className="mt-10 inline-block underline underline-offset-4">iPhone privacy</Link>
    </main>
  );
}
