"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function IOSConnect({authorization,user,providers}:{authorization:{code_challenge:string;state:string};user:{id:string;name:string;email:string}|null;providers:{google:boolean;email:boolean}}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const button = "h-11 w-full bg-foreground px-4 text-sm text-background disabled:opacity-40";
  async function connect() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ios/authorize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...authorization,expectedUserId:user?.id})});
      if (!response.ok) throw new Error();
      const result = await response.json();
      const url = new URL(result.callbackURL);
      if (url.protocol !== "dev.gtfol.freewrite:" || url.host !== "auth" || url.pathname !== "/callback") throw new Error();
      window.location.assign(url.toString());
    } catch { setError("couldn’t connect. return to the freewrite app and try again."); setBusy(false); }
  }
  async function social(provider: "google") {
    setBusy(true); setError("");
    try {
      const result = await authClient.signIn.social({provider,callbackURL:window.location.href});
      if (result.error) throw new Error();
    } catch { setError("couldn’t start sign-in. try again."); setBusy(false); }
  }
  async function emailSignIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await authClient.signIn.email({email,password});
      if (result.error) throw new Error();
      setPassword(""); window.location.reload();
    } catch { setError("couldn’t sign in. check your details and try again."); setBusy(false); }
  }
  return <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-12">
    <h1 className="text-lg">freewrite</h1>
    <p className="text-sm text-muted-foreground">connect your freewrite account to this iPhone.</p>
    <p className="text-sm text-muted-foreground">this test build supports account sign-in. entries still stay on your iPhone; cloud sync is coming next.</p>
    {user ? <>
      <button className={button} disabled={busy} onClick={()=>void connect()}>{busy ? "connecting…" : `continue as ${user.name || user.email}`}</button>
      <button className="text-sm text-muted-foreground" disabled={busy} onClick={async()=>{setBusy(true);try { const result=await authClient.signOut();if(result.error) throw new Error();window.location.reload(); } catch {setBusy(false);setError("couldn’t switch accounts. try again.");}}}>use another account</button>
      <p className="text-xs text-muted-foreground">sign out anytime in the app’s settings.</p>
    </> : <>
      {providers.google && <button className={button} disabled={busy} onClick={()=>void social("google")}>{busy ? "connecting…" : "continue with google"}</button>}
      {providers.email && <form className="space-y-4" onSubmit={emailSignIn}>
        <label className="field-label">email<input className="w-full border-b border-border py-2" type="email" required autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} /></label>
        <label className="field-label">password<input className="w-full border-b border-border py-2" type="password" required autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} /></label>
        <button className={button} disabled={busy}>{busy ? "connecting…" : "sign in"}</button>
      </form>}
      {!providers.google && !providers.email && <p className="text-sm">sign-in is unavailable. try again later.</p>}
    </>}
    {error && <p className="text-sm" role="alert">{error}</p>}
  </main>;
}
