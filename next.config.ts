import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
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
