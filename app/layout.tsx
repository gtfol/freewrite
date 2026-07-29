import type { Metadata, Viewport } from "next";
import {
  Crimson_Pro,
  EB_Garamond,
  IBM_Plex_Mono,
  Inter,
  Lato,
} from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { ViewportLock } from "@/components/viewport-lock";
import "./globals.css";

const lato = Lato({
  variable: "--font-lato",
  weight: ["300", "400", "700"],
  subsets: ["latin"],
});

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

const crimson = Crimson_Pro({
  variable: "--font-crimson",
  subsets: ["latin"],
});

const garamond = EB_Garamond({
  variable: "--font-garamond",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "freewrite",
  description: "Write. Don't stop.",
  robots: { index: false, follow: false },
};

// Scale 1, so a stray double-tap or a rotation can't leave the reader zoomed
// into the middle of a paragraph. ViewportLock lifts this for a real pinch and
// restores it afterwards — the cap is against accidents, not against zooming.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${lato.variable} ${inter.variable} ${crimson.variable} ${garamond.variable} ${plexMono.variable} font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          disableTransitionOnChange
        >
          <ViewportLock />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
