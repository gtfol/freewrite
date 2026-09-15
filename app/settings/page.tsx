'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { SupportLink } from '@/components/support-link';
import { SettingsLink } from '@/components/settings-link';
import { SyncPopover } from '@/components/sync-popover';
import { StorageSidebar } from '@/components/storage-sidebar';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { readPersonalData, resetPersonalData } from '@/lib/db';
import { personalDataExport } from '@/lib/personal-data';
import { revokeAllSharesAnd } from '@/lib/shares';
import { useWriter } from '@/lib/store';
import { useSync } from '@/lib/sync';
import { authClient } from '@/lib/auth-client';

const action = 'text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40';

export default function SettingsPage() {
  const {theme, setTheme} = useTheme();
  const user = useSync(s => s.user);
  const status = useSync(s => s.status);
  const [storage, setStorage] = useState(false);
  const [confirm, setConfirm] = useState<{userId: string | null} | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const deleted = useRef(false);

  async function exportData() {
    setBusy(true); setMessage('');
    try {
      const snapshot = await readPersonalData();
      // Include the current draft even if its debounced save is still pending.
      const writer = useWriter.getState();
      if (writer.ready) for (const entry of writer.entries) {
        const index = snapshot.entries.findIndex(e => e.id === entry.id);
        if (index < 0) snapshot.entries.push(entry);
        else if (entry.updatedAt >= snapshot.entries[index].updatedAt) snapshot.entries[index] = entry;
      }
      const pdfs = await Promise.all(snapshot.pdfs.map(async pdf => {
        const bytes = new Uint8Array(await pdf.file.arrayBuffer());
        const chunks: string[] = [];
        for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
        return {articleId: pdf.articleId, name: pdf.name, encoding: 'base64', data: btoa(chunks.join(''))};
      }));
      const blob = new Blob([JSON.stringify({...personalDataExport(snapshot), pdfs}, null, 2)], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `freewrite-${new Date().toISOString().slice(0,10)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage('Export downloaded.');
    } catch { setMessage('Could not export your data. Try again.'); }
    finally { setBusy(false); }
  }

  async function removeData() {
    if (!confirm || confirmation !== 'DELETE') return;
    setBusy(true); setMessage('');
    try {
      if (!deleted.current && (useSync.getState().user?.id ?? null) !== confirm.userId) throw new Error('Your session changed. Reload and try again.');
      if (!deleted.current && status !== 'disabled') {
        const session = await authClient.getSession({query: {disableCookieCache: true}});
        if (session.error) throw new Error('Could not check your session. Try again.');
        if ((session.data?.user.id ?? null) !== confirm.userId) throw new Error('Your session changed. Reload and try again.');
      }
      await revokeAllSharesAnd(async () => {
        if (confirm.userId && !deleted.current) {
          const res = await fetch('/api/account', {method: 'DELETE', headers: {'content-type': 'application/json'}, body: JSON.stringify({expectedUserId: confirm.userId, confirmation})});
          const result = await res.json();
          if (!res.ok) throw new Error(result.error ?? 'Could not delete your account.');
          deleted.current = true;
        }
        await resetPersonalData();
        // Only Freewrite's own preferences/cursors/capabilities are removed.
        for (const key of Object.keys(localStorage)) if (key.startsWith('freewrite:')) localStorage.removeItem(key);
      });
      window.location.replace('/');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not clear your data. Try again.'); setBusy(false); }
  }

  return <>
    <main className="mx-auto w-full max-w-[528px] overflow-y-auto px-6 pt-[30px] pb-28 text-[13px]">
      <h1 className="mb-10 text-sm font-normal">Settings</h1>
      <section className="space-y-5">
        <h2 className="font-normal">Your data</h2>
        <div>
          <button disabled={busy} onClick={() => void exportData()} className={action}>Export data</button>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Entries, drawings, saved articles, highlights, and original PDFs from this browser. Downloads as JSON; generated audio is excluded.</p>
        </div>
        <button disabled={busy || status === 'loading'} className={action} onClick={() => {setConfirm({userId: user?.id ?? null}); setConfirmation(''); setMessage('');}}>
          {user ? 'Delete account' : 'Clear browser data'}
        </button>
      </section>
      <section className="mt-10 space-y-5">
        <h2 className="font-normal">Audio</h2>
        <button disabled={busy} className={action} onClick={() => setStorage(true)}>Manage downloads and storage</button>
      </section>
      <p role="status" className="mt-5 text-xs text-muted-foreground">{!confirm && message}</p>
      <a className={`mt-10 inline-block ${action}`} href="https://github.com/gtfol/freewrite" target="_blank" rel="noopener noreferrer">Source code</a>
    </main>
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-center gap-3 bg-background px-6 py-4 text-[13px]">
      <Link className={action} href="/">Write</Link><span className="text-muted-foreground/40">•</span><Link className={action} href="/read">Read</Link><span className="text-muted-foreground/40">•</span>
      <button aria-label="Toggle theme" className={action} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
      <SyncPopover /><SupportLink /><SettingsLink />
    </nav>
    {storage && <StorageSidebar open onClose={() => setStorage(false)} />}
    <AlertDialog open={!!confirm} onOpenChange={open => {if (!open && !busy) setConfirm(null);}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-normal">{confirm?.userId ? 'Delete account?' : 'Clear browser data?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirm?.userId ? 'Permanently deletes your account, synced writing, articles, drawings, and Spotify history, plus saved content and audio in this browser.' : 'Permanently removes saved writing, articles, drawings, PDFs, and audio from this browser.'}
            {' '}Share links managed in this browser will be removed. Links managed only in other browsers and content saved on other devices are not cleared. Export anything you want to keep first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="text-[13px]">Type DELETE to confirm
          <input value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} autoComplete="off" className="mt-2 w-full border-b bg-transparent py-2 outline-none focus:border-foreground" />
        </label>
        <p role="alert" className="text-xs text-muted-foreground">{message}</p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <button disabled={busy || confirmation !== 'DELETE'} onClick={() => void removeData()} className="bg-foreground px-4 py-2 text-sm text-background disabled:opacity-40">{busy ? 'Deleting…' : 'Delete'}</button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
