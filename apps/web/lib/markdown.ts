// HTML → markdown for chat prompts and share snapshots. Article content is
// already sanitized down to a small closed tag set (see lib/extract.ts), so
// this converter only needs to handle exactly those tags. Client-side only
// (DOMParser).

const INLINE_TAGS = new Set([
  "A", "STRONG", "B", "EM", "I", "CITE", "CODE", "S", "U",
  "MARK", "SPAN", "SUP", "SUB", "BR", "IMG",
]);

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const inner = Array.from(el.childNodes).map(inline).join("");

  switch (el.tagName) {
    case "SPAN": {
      const cls = el.getAttribute("class") ?? "";
      if (/\bmath\b/.test(cls)) {
        const tex = (el.textContent ?? "").trim();
        if (!tex) return "";
        return /\bmath-display\b/.test(cls) ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
      }
      return inner;
    }
    case "A": {
      const href = el.getAttribute("href");
      const label = inner.trim();
      if (!label) return "";
      return href ? `[${label}](${href})` : label;
    }
    case "STRONG":
    case "B":
      return inner.trim() ? `**${inner.trim()}**` : "";
    case "EM":
    case "I":
    case "CITE":
      return inner.trim() ? `*${inner.trim()}*` : "";
    case "CODE":
      return inner.trim() ? `\`${inner.trim()}\`` : "";
    case "S":
      return inner.trim() ? `~~${inner.trim()}~~` : "";
    case "BR":
      return "\n";
    case "IMG": {
      const src = el.getAttribute("src");
      return src ? `![${el.getAttribute("alt") ?? ""}](${src})` : "";
    }
    default:
      return inner;
  }
}

function list(el: Element, depth: number): string {
  const ordered = el.tagName === "OL";
  let index = 1;
  let out = "";
  for (const li of Array.from(el.children)) {
    if (li.tagName !== "LI") continue;
    let text = "";
    let nested = "";
    for (const child of Array.from(li.childNodes)) {
      const tag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName : "";
      if (tag === "UL" || tag === "OL") {
        nested += list(child as Element, depth + 1);
      } else if (tag && !INLINE_TAGS.has(tag)) {
        text += (text ? " " : "") + blockChildren(child).replace(/\n+/g, " ");
      } else {
        text += inline(child);
      }
    }
    out += `${"  ".repeat(depth)}${ordered ? `${index++}. ` : "- "}${text.trim()}\n${nested}`;
  }
  return out;
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll("tr"))
    .map((tr) =>
      Array.from(tr.querySelectorAll("th, td")).map((cell) =>
        inline(cell).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
      )
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const lines = [header, header.map(() => "---"), ...body];
  return lines.map((cells) => `| ${cells.join(" | ")} |`).join("\n") + "\n\n";
}

function block(el: Element): string {
  switch (el.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = Number(el.tagName[1]);
      const text = inline(el).trim();
      return text ? `${"#".repeat(level)} ${text}\n\n` : "";
    }
    case "P": {
      const text = inline(el).trim();
      return text ? `${text}\n\n` : "";
    }
    case "BLOCKQUOTE": {
      const inner = blockChildren(el).trim();
      if (!inner) return "";
      return inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") + "\n\n";
    }
    case "UL":
    case "OL": {
      const items = list(el, 0);
      return items ? `${items}\n` : "";
    }
    case "PRE": {
      const code = (el.textContent ?? "").replace(/\n$/, "");
      return code ? `\`\`\`\n${code}\n\`\`\`\n\n` : "";
    }
    case "HR":
      return "---\n\n";
    case "FIGCAPTION": {
      const text = inline(el).trim();
      return text ? `*${text}*\n\n` : "";
    }
    case "TABLE":
      return table(el);
    default:
      // div, aside, figure — pure containers here; recurse.
      return blockChildren(el);
  }
}

function blockChildren(container: Node): string {
  let out = "";
  let para = "";
  const flush = () => {
    const text = para.trim();
    if (text) out += `${text}\n\n`;
    para = "";
  };
  for (const node of Array.from(container.childNodes)) {
    const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : "";
    if (node.nodeType === Node.TEXT_NODE || INLINE_TAGS.has(tag)) {
      para += inline(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      flush();
      out += block(node as Element);
    }
  }
  flush();
  return out;
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return blockChildren(doc.body).replace(/\n{3,}/g, "\n\n").trim();
}
