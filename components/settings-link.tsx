'use client';
import Link from 'next/link';
import { Settings } from 'lucide-react';
import { useWriter } from '@/lib/store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function SettingsLink() {
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>
    <Link href="/settings" onClick={() => useWriter.getState().flush()} aria-label="Settings"
      className="flex items-center text-muted-foreground transition-colors hover:text-foreground">
      <Settings size={14} strokeWidth={1.5} />
    </Link>
  </TooltipTrigger><TooltipContent side="top">Settings</TooltipContent></Tooltip></TooltipProvider>;
}
