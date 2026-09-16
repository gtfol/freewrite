'use client';

import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { StorageSidebar } from '@/components/storage-sidebar';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { readPersonalData, resetPersonalData } from '@/lib/db';
import { personalDataExport } from '@/lib/personal-data';
import { revokeAllSharesAnd } from '@/lib/shares';
import { useWriter } from '@/lib/store';
import { useSync } from '@/lib/sync';
import { authClient } from '@/lib/auth-client';

const action = 'text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40';

export function SettingsPanel({open, onClose}: {open: boolean; onClose: () => void}) {
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

  return <Dialog.Root open={open} onOpenChange={value => {if (!value && !busy) {setStorage(false); onClose();}}}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/15 dark:bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
      <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] overflow-y-auto border-l bg-background px-7 pt-6 pb-8 text-[13px] outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-200 motion-reduce:animate-none" onCloseAutoFocus={event => {event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-settings-trigger]')?.focus();}} onEscapeKeyDown={event => {if (storage) {event.preventDefault(); setStorage(false);}}}>
      <Dialog.Title className="mb-10 pr-10 text-sm font-normal">Settings</Dialog.Title>
      <Dialog.Close disabled={busy} aria-label="Close settings" className="absolute right-5 top-4 p-2 text-muted-foreground hover:text-foreground disabled:opacity-40"><X size={14} strokeWidth={1.5} /></Dialog.Close>
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
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
