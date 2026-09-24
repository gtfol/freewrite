'use client';
import { useSettings } from './settings-provider';
import { Settings } from 'lucide-react';
import { useWriter } from '@/lib/store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function SettingsLink() {
  const {open, show} = useSettings();
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>
    <button type="button" data-settings-trigger aria-haspopup="dialog" aria-expanded={open} onClick={() => {useWriter.getState().flush(); show();}} aria-label="Settings"
      className="flex items-center text-muted-foreground transition-colors hover:text-foreground">
      <Settings className="size-4" />
    </button>
  </TooltipTrigger><TooltipContent side="top">Settings</TooltipContent></Tooltip></TooltipProvider>;
}
