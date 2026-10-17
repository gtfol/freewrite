import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { render, type mount, type MountOptions } from "pele";
import { DIAGRAM_OPTIONS, DIAGRAM_TEMPLATE, diagramFrame, diagramUnavailable, mountDiagrams } from "./mermaid.ts";

function frame(source: string) {
  return parseHTML(`<html><body>${diagramFrame(source)}</body></html>`).document.body;
}

test("diagram source remains literal, including attempted HTML breakout", () => {
  const source = 'flowchart TD\nA["</code></pre><img src=x onerror=alert(1)> & text"]';
  const root = frame(source);
  assert.equal(root.querySelector("code")?.textContent, source);
  assert.equal(root.querySelector("img"), null);
  diagramUnavailable(root);
  assert.match(root.querySelector("[role=status]")!.textContent!, /unavailable/);
  assert.equal(root.querySelector("code")?.textContent, source);
});

test("Pele renders the slash-command template and sequence diagrams", () => {
  const source = DIAGRAM_TEMPLATE.split("```mermaid\n")[1].split("```")[0];
  for (const text of [source, "sequenceDiagram\nAlice->>Bob: Hello"]) {
    const diagram = render(text, DIAGRAM_OPTIONS);
    assert.match(diagram.svg, /<svg/);
    assert.ok(diagram.width > 0 && diagram.height > 0);
  }
});

test("shared diagrams cannot create links, remote images or HTML handlers", () => {
  const sources = [
    'flowchart TD\nA["<img src=x onerror=alert(1)>"] --> B\nclick B "https://example.com"',
    'flowchart TD\nA@{ img: "https://example.com/tracker.png", label: "Image", h: 60 }',
    'flowchart TD\nA --> B\nclick B "javascript:alert(1)"',
  ];
  for (const source of sources) {
    const { svg } = render(source, DIAGRAM_OPTIONS);
    const { document } = parseHTML(svg);
    assert.equal(document.querySelector("script, foreignObject, image, img, a, [onerror], [onclick]"), null);
  }
});

test("oversized source and excessive edges fail within configured bounds", () => {
  assert.throws(() => render("flowchart TD\n" + "A".repeat(20_000), DIAGRAM_OPTIONS));
  const edges = Array.from({ length: 501 }, (_, i) => `A${i} --> A${i + 1}`).join("\n");
  assert.throws(() => render("flowchart TD\n" + edges, DIAGRAM_OPTIONS));
});

test("mount callbacks reveal source on failure and disconnect every diagram", () => {
  const root = frame("flowchart TD\nA --> B");
  let options: MountOptions | undefined;
  let destroyed = 0;
  const fakeMount = ((_node: HTMLElement, source: string, opts?: MountOptions) => {
    assert.equal(source, "flowchart TD\nA --> B");
    options = opts;
    return { destroy() { destroyed++; } };
  }) as unknown as typeof mount;
  const destroy = mountDiagrams(root, fakeMount);
  const details = root.querySelector("details")!;
  const status = root.querySelector<HTMLElement>("[role=status]")!;
  options!.onRender!(render("flowchart TD\nA --> B"));
  assert.equal(status.hidden, true);
  assert.equal(details.open, false);
  options!.onError!(new Error("<script>private entry text</script>"));
  assert.equal(status.hidden, false);
  assert.equal(details.open, true);
  assert.doesNotMatch(status.textContent!, /private entry text/);
  destroy();
  assert.equal(destroyed, 1);
});

test("a mount exception preserves source and does not stop other diagrams", () => {
  const root = frame("first");
  root.insertAdjacentHTML("beforeend", diagramFrame("second"));
  let attempts = 0;
  let destroyed = 0;
  const fakeMount = (() => {
    if (++attempts === 1) throw new Error("failed");
    return { destroy() { destroyed++; } };
  }) as unknown as typeof mount;
  const destroy = mountDiagrams(root, fakeMount);
  assert.equal(attempts, 2);
  assert.match(root.querySelector("[role=status]")!.textContent!, /unavailable/);
  assert.equal(root.querySelector("code")?.textContent, "first");
  destroy();
  assert.equal(destroyed, 1);
});
