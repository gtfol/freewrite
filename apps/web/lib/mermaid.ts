import type { mount, RenderOptions } from "pele";

// Entry text, including shared entries, is untrusted. Diagrams never fetch
// images or turn source directives into clickable links.
export const DIAGRAM_OPTIONS: RenderOptions = {
  links: false,
  images: false,
  limit: 20_000,
  maxEdges: 500,
  outputLimit: 1_000_000,
};

export const DIAGRAM_TEMPLATE = "\n\n```mermaid\nflowchart TD\n  Idea --> Draft\n  Draft --> Done\n```\n\n";

export function diagramFrame(source: string): string {
  const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<figure class="mermaid-diagram" aria-label="Mermaid diagram"><div data-mermaid-canvas></div><p data-mermaid-status role="status">Loading diagram…</p><details open><summary>Diagram source</summary><pre><code>${escaped}</code></pre></details></figure>\n`;
}

export function diagramUnavailable(root: HTMLElement) {
  for (const status of root.querySelectorAll<HTMLElement>("[data-mermaid-status]")) {
    status.hidden = false;
    status.textContent = "Diagram unavailable. Your source is shown below.";
  }
}

// Keep the source outside Pele's mount point, so malformed syntax or a failed
// library load can never replace or discard the writer's text.
export function mountDiagrams(root: HTMLElement, mountDiagram: typeof mount) {
  const diagrams: ReturnType<typeof mount>[] = [];
  for (const frame of root.querySelectorAll<HTMLElement>(".mermaid-diagram")) {
    const canvas = frame.querySelector<HTMLElement>("[data-mermaid-canvas]");
    const details = frame.querySelector("details");
    const status = frame.querySelector<HTMLElement>("[data-mermaid-status]");
    const source = details?.querySelector("code")?.textContent;
    if (!canvas || !details || !status || source === undefined || source === null) continue;
    try {
      diagrams.push(mountDiagram(canvas, source, {
        ...DIAGRAM_OPTIONS,
        onRender: () => {
          status.hidden = true;
          details.open = false;
        },
        onError: () => {
          status.hidden = false;
          status.textContent = "Couldn't render this diagram. Check the source below.";
          details.open = true;
        },
      }));
    } catch {
      diagramUnavailable(frame);
    }
  }
  return () => {
    for (const diagram of diagrams) diagram.destroy();
  };
}
