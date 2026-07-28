import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  // The Piper voice engine is Emscripten output that ships one bundle for Node
  // and the browser, referencing `fs`/`path` behind a runtime isNode check that
  // is never true here. Nothing to refactor — the imports are in third-party
  // WASM glue — so point them at an empty module.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./lib/tts/empty.ts" },
      path: { browser: "./lib/tts/empty.ts" },
    },
  },
  // Personal reading/writing app — keep every response (pages, API, future
  // share links) out of search engines. Deliberately no robots.txt Disallow:
  // crawlers must be able to fetch a page to see its noindex directive.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
