import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "iPhone privacy · freewrite" };

export default function IOSPrivacyPage() {
  return (
    <main className="mx-auto max-w-[650px] px-6 py-14 text-sm leading-7">
      <Link href="/" className="text-muted-foreground">freewrite</Link>
      <h1 className="mt-8 text-2xl">Privacy on iPhone</h1>
      <p className="mt-3 text-muted-foreground">Updated September 23, 2026 · gtfol, LLC</p>
      <div className="mt-8 space-y-6">
        <p>This page describes the native freewrite iPhone app. The website has separate features, including optional accounts and sync.</p>
        <section>
          <h2 className="text-base">Your writing stays on your iPhone</h2>
          <p>Entries and drafts are saved in the app’s local database. This version has no sign-in, cloud sync, advertising, or analytics. Your entries may be included in device backups according to your Apple settings.</p>
          <p>Deleting an entry clears its text from the app’s database and retains an empty deletion record. Removing the app removes its local data; any device backups are managed separately through your Apple settings.</p>
        </section>
        <section>
          <h2 className="text-base">On-device dictation</h2>
          <p>The microphone is used only when you start dictation. Apple’s on-device speech framework transcribes audio. Audio stays in memory: the app does not save audio files or upload audio. Speech models may need to download from Apple before first use.</p>
          <p>Transcript text saves as you speak. Stopping, an interruption, or moving the app into the background stops recording. After a crash, the latest words that had not yet been saved may be lost.</p>
        </section>
        <section>
          <h2 className="text-base">On-device cleanup</h2>
          <p>After dictation stops, cleanup removes clear English fillers and tidies punctuation on your iPhone. No text is sent to an AI service, and no API key or account is required. Other languages retain the speech framework’s transcript. You can undo cleanup to restore the original words.</p>
        </section>
        <section>
          <h2 className="text-base">Voluntary support</h2>
          <p>If you choose “support freewrite,” Stripe’s checkout opens in your browser. Stripe processes your payment and may receive network information such as your IP address. freewrite does not receive your full card number. A payment is optional and does not unlock app features.</p>
        </section>
        <section>
          <h2 className="text-base">Contact</h2>
          <p>freewrite is operated by gtfol, LLC. For privacy questions, <a className="underline underline-offset-4" href="https://gtfol.dev/contact">contact gtfol</a>. Please avoid including private writing or API keys in support requests.</p>
        </section>
      </div>
      <a href="https://gtfol.dev/contact" className="mt-10 inline-block underline underline-offset-4">contact us</a>
    </main>
  );
}
