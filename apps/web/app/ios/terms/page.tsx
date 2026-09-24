import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "terms of service · freewrite" };

export default function IOSTermsPage() {
  return (
    <main className="mx-auto max-w-[650px] px-6 py-14 text-sm leading-7">
      <Link href="/" className="text-muted-foreground">freewrite</Link>
      <h1 className="mt-8 text-2xl">Terms of service</h1>
      <p className="mt-3 text-muted-foreground">Updated September 23, 2026 · gtfol, LLC</p>
      <div className="mt-8 space-y-6">
        <p>These terms cover freewrite on the web and iPhone, provided by gtfol, LLC. By using the services, you agree to these terms. <a href="https://gtfol.dev/contact" className="underline underline-offset-4">Contact us</a> with questions.</p>
        <section>
          <h2 className="text-base">Using freewrite</h2>
          <p>freewrite helps you write, dictate, and read saved material. Features vary by platform and version. Keep your account secure. Use the services lawfully, without accessing another person’s data, bypassing security, or disrupting the service.</p>
        </section>
        <section>
          <h2 className="text-base">Your content</h2>
          <p>You retain ownership of your writing and drawings. Only import, upload, or share content you have permission to use. You give us permission to store, process, and display content as needed to provide the features you choose, such as sync and sharing. This permission does not transfer ownership.</p>
          <p>Anyone with a share link may view and copy its contents. Check what you share before publishing a link. Removing a link cannot recall copies others have saved.</p>
        </section>
        <section>
          <h2 className="text-base">Transcription and imported material</h2>
          <p>Speech transcription, cleanup, and article extraction can be inaccurate or incomplete. Review results before relying on them. freewrite does not guarantee that imported pages remain available or that every spoken word is recognized.</p>
        </section>
        <section>
          <h2 className="text-base">Cost and voluntary support</h2>
          <p>freewrite currently has no subscription or paywall. Voluntary support payments are optional and do not unlock features. Stripe processes those payments under its own terms. Contact us about payment problems.</p>
        </section>
        <section>
          <h2 className="text-base">Data and availability</h2>
          <p>The <Link href="/ios/privacy" className="underline underline-offset-4">iPhone privacy policy</Link> explains storage and processing in the native app. Local data can be lost if you clear browser data, remove the app, or lose access to your device. Keep copies of writing you want to preserve. We cannot guarantee uninterrupted service or recovery of local data.</p>
          <p>To the extent permitted by law, the services are provided as available, without guarantees that every result will be accurate or error-free. Nothing in these terms limits consumer rights or liabilities that cannot legally be excluded.</p>
        </section>
        <section>
          <h2 className="text-base">Ending use</h2>
          <p>You can stop using freewrite at any time. If you have a web account, use <Link href="/settings" className="underline underline-offset-4">Settings</Link> to delete it. Local copies and content already shared with others may remain. We may restrict access where reasonably necessary to address abuse, security risks, or legal requirements.</p>
        </section>
        <section>
          <h2 className="text-base">The iPhone app and source code</h2>
          <p>The App Store version is also licensed under <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/" className="underline underline-offset-4">Apple’s Standard License Agreement</a>. These service terms do not replace that license. Open-source components retain their respective licenses.</p>
        </section>
        <section>
          <h2 className="text-base">Changes and contact</h2>
          <p>We may update these terms as the service changes. Revisions will appear here with an updated date, with notice through the service for material changes. <a href="https://gtfol.dev/contact" className="underline underline-offset-4">Contact us</a> with questions.</p>
        </section>
      </div>
    </main>
  );
}
