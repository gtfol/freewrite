"use client";

import { useRef, useState, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";

type Props = { label: string; children: ReactNode; active?: boolean };

export function InfoTooltip({ active = true, ...props }: Props) {
  // Views stay mounted between tabs; their portaled help must close on leave.
  return active ? <InfoTooltipContent {...props} /> : null;
}

function InfoTooltipContent({ label, children }: Omit<Props, "active">) {
  const [open, setOpen] = useState(false);
  const openOnPress = useRef(false);

  return <Tooltip.Provider delayDuration={200}><Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger asChild><button
      type="button"
      aria-label={label}
      aria-expanded={open}
      className="-my-1 inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      onPointerDown={() => { openOnPress.current = open; }}
      onClick={(event) => {
        // Radix closes tooltips on pointer down. Keep tap-to-toggle available
        // on touch devices using the state from before that dismissal.
        event.preventDefault();
        setOpen(event.detail === 0 ? !open : !openOnPress.current);
      }}
    ><Info size={12} strokeWidth={1.4} aria-hidden="true" /></button></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content side="bottom" align="start" sideOffset={6} collisionPadding={16} className="z-[100] w-64 max-w-[calc(100vw-32px)] rounded-sm border border-border bg-popover px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-sm">{children}</Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root></Tooltip.Provider>;
}
