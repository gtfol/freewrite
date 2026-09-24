import sanitizeHtml from "sanitize-html";

function absolutize(value: string | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const resolved = new URL(value, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

// Pasted pages arrive with app chrome around the text; these tags (and
// their text) are noise there, whereas Readability output never has them.
const CHROME_TAGS = [
  "script", "style", "noscript", "textarea", "option", "select",
  "button", "nav", "form", "dialog", "svg", "canvas", "iframe",
  "audio", "video",
];

export function sanitizeContent(
  html: string,
  baseUrl: string,
  { discardChrome = false } = {}
): string {
  return sanitizeHtml(html, {
    ...(discardChrome ? { nonTextTags: CHROME_TAGS } : {}),
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "a", "ul", "ol", "li", "blockquote",
      "pre", "code", "em", "strong", "b", "i", "u", "s",
      "br", "hr", "img", "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td",
      "sup", "sub", "mark", "cite", "aside", "div", "span",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    // TeX carriers rendered client-side by KaTeX on the article page.
    allowedClasses: { span: ["math", "math-display"] },
    allowedSchemes: ["http", "https"],
    transformTags: {
      a: (tagName, attribs) => {
        const href = absolutize(attribs.href, baseUrl);
        return {
          tagName,
          attribs: {
            ...(href ? { href } : {}),
            ...(attribs.title ? { title: attribs.title } : {}),
            target: "_blank",
            rel: "noreferrer noopener",
          },
        };
      },
      img: (tagName, attribs) => {
        const src = absolutize(attribs.src, baseUrl);
        return {
          tagName,
          attribs: {
            ...(src ? { src } : {}),
            ...(attribs.alt ? { alt: attribs.alt } : {}),
            loading: "lazy",
          },
        };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}
