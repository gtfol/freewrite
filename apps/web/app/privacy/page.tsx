import type { Metadata } from "next";
import Link from "next/link";
export const metadata: Metadata = { title: "Privacy · freewrite" };
export default function PrivacyPage() {
  return <main className="mx-auto max-w-[650px] px-6 py-14 text-sm leading-7">
    <Link href="/" className="text-muted-foreground">freewrite</Link>
    <h1 className="mt-8 text-2xl">Privacy</h1>
    <p className="mt-3 text-muted-foreground">Updated September 24, 2026 · gtfol, LLC</p>
    <div className="mt-8 space-y-6">
      <section><h2 className="text-base">Your content and account</h2><p>freewrite saves writing, drawings, and imported articles in your browser. Signing in connects your account and enables cloud sync through our hosting and database providers. Your account includes your name, email address, and account identifier. You can export your data or delete your account in Settings. Content you share with others and copies on other devices are separate.</p></section>
      <section><h2 className="text-base">Usage analytics</h2><p>We use PostHog’s US service for basic page visits and actions such as creating an entry, opening history, or editing an article. Events include random browser and session identifiers. Page addresses are reduced to known routes: article and share identifiers, query strings, and fragments are removed. Authentication pages are excluded.</p><p>We do not send journal text, article content, drawings, dictated words, names, email addresses, or account identifiers to analytics. Automatic interaction capture, screen recording, and automatic error capture are disabled. We do not create identified analytics profiles or use analytics for advertising.</p><p>A random analytics identifier is stored in your browser’s local storage. You can turn off “Share usage analytics” in Settings; we also respect Do Not Track and Global Privacy Control. PostHog receives network information when your browser connects; IP-based location enrichment is disabled.</p></section>
      <section><h2 className="text-base">Services you choose</h2><p>Importing a page, using a connected service, sharing content, or opening a chat provider involves that service as described by the feature. Voluntary support payments are processed by Stripe. These actions are separate from usage analytics.</p></section>
      <section><h2 className="text-base">Contact</h2><p>For privacy questions, <a href="https://gtfol.dev/contact" className="underline underline-offset-4">contact us</a>. The native app has its own <Link href="/ios/privacy" className="underline underline-offset-4">iPhone privacy policy</Link>.</p></section>
    </div>
  </main>;
}
