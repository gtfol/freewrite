import { headers } from "next/headers";
import type { Metadata } from "next";
import { getAuth, enabledProviders } from "@/lib/server/auth";
import { iosAuthorization } from "@/lib/server/ios-auth";
import { IOSConnect } from "@/components/ios-connect";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: "sign in · freewrite", referrer: "no-referrer"};
export default async function IOSConnectPage({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const authorization = iosAuthorization(await searchParams);
  if (!authorization) return <main className="mx-auto max-w-sm px-6 py-20"><h1 className="text-lg">freewrite</h1><p className="mt-6 text-sm text-muted-foreground">open freewrite on your iPhone to sign in.</p></main>;
  const session = await getAuth()?.api.getSession({headers: await headers(), query: {disableCookieCache: true}}).catch(() => null);
  return <IOSConnect authorization={authorization} user={session ? {id: session.user.id, name: session.user.name, email: session.user.email} : null} providers={enabledProviders()} />;
}
