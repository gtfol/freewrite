"use client";

import { trackUsage } from "@/lib/analytics";

import { Suspense, createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SettingsPanel } from "./settings-panel";

const SettingsContext = createContext({ open: false, show: () => {} });
export const useSettings = () => useContext(SettingsContext);

function SettingsDeepLink({ show }: { show: () => void }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (params.get("settings") !== "open") return;
    show();
    const next = new URLSearchParams(params.toString());
    next.delete("settings");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [params, pathname, router, show]);
  return null;
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => { trackUsage("settings_opened"); setOpen(true); }, []);
  return <SettingsContext.Provider value={{ open, show }}>
    {children}
    <Suspense fallback={null}><SettingsDeepLink show={show} /></Suspense>
    <SettingsPanel open={open} onClose={() => setOpen(false)} />
  </SettingsContext.Provider>;
}
