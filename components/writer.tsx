"use client";

import { useEffect } from "react";

import { BottomNav } from "@/components/bottom-nav";
import { Editor } from "@/components/editor";
import { HistorySidebar } from "@/components/history-sidebar";
import { SaveStatus } from "@/components/save-status";
import { useMounted } from "@/hooks/use-mounted";
import { useWriter } from "@/lib/store";

export function Writer() {
  const mounted = useMounted();
  const ready = useWriter((s) => s.ready);
  const init = useWriter((s) => s.init);
  const flush = useWriter((s) => s.flush);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  if (!mounted || !ready) return <main className="h-dvh" />;

  return (
    <main className="h-dvh">
      <Editor />
      <SaveStatus />
      <BottomNav />
      <HistorySidebar />
    </main>
  );
}
