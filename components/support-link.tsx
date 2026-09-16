'use client';

import { ArrowUpRight } from 'lucide-react';

// This is a public checkout URL, never a Stripe API credential.
export function SupportLink({className}: {className?: string}) {
  return <a href="https://buy.stripe.com/bJeaEY2jG3ZF1gKbezenS04" target="_blank" rel="noopener noreferrer"
    aria-label="Support Freewrite (opens in a new tab)" className={className}>
    Support Freewrite <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" />
  </a>;
}
