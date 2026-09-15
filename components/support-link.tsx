'use client';

import { Heart } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// This is a public checkout URL, never a Stripe API credential.
export function SupportLink() {
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>
    <a href="https://buy.stripe.com/bJeaEY2jG3ZF1gKbezenS04" target="_blank" rel="noopener noreferrer"
      aria-label="Support Freewrite (opens in a new tab)" className="flex items-center text-muted-foreground transition-colors hover:text-foreground">
      <Heart size={14} strokeWidth={1.5} />
    </a>
  </TooltipTrigger><TooltipContent side="top">Support Freewrite</TooltipContent></Tooltip></TooltipProvider>;
}
