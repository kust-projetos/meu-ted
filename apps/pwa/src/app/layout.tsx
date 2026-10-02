import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
// FIX-PWA-FONT-BUILD: self-hosted variable fonts (latin, pt-BR coverage).
// next/font/google downloads fonts from Google at build time and broke CI
// with "next/font: TypeError: Cannot read properties of null" flakes.
import localFont from "next/font/local";
import { RootProviders } from "@/components/RootProviders";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const plusJakartaSans = localFont({
  src: [{ path: "../fonts/PlusJakartaSans-Variable.woff2", weight: "200 800", style: "normal" }],
  variable: "--font-plus-jakarta-sans",
  display: "swap",
});

const spaceGrotesk = localFont({
  src: [{ path: "../fonts/SpaceGrotesk-Variable.woff2", weight: "300 700", style: "normal" }],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meu Ted — Tudo em dia.",
  description: "Finanças mais simples. Uma vida mais sua.",
  applicationName: "Meu Ted",
  appleWebApp: {
    capable: true,
    title: "Meu Ted",
    statusBarStyle: "default",
  },
  openGraph: {
    title: "Meu Ted — Tudo em dia.",
    description: "Finanças mais simples. Uma vida mais sua.",
    type: "website",
    locale: "pt_BR",
    siteName: "Meu Ted",
  },
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // A5: zoom liberado (WCAG 1.4.4) — iOS só aplica pinch-zoom em inputs
  // com font-size >= 16px. Contrato global em `globals.css` (regra
  // `pointer: coarse` cobre input/textarea/select em todo o app;
  // AuthGate e NewTransactionSheet/Input já estavam 16px por componente).
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1F2A27" },
    { media: "(prefers-color-scheme: light)", color: "#0B7A5B" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonce issued per request by src/middleware.ts (x-nonce request header).
  // The shipped CSP (buildCspValue) allows inline scripts ONLY with this
  // nonce — without it the theme bootstrap below is blocked in production
  // (HIGH #3). Layout is force-dynamic, so reading headers() is allowed.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={`${plusJakartaSans.variable} ${spaceGrotesk.variable}`}
    >
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: THEME_SCRIPT,
          }}
        />
      </head>
      <body className="font-ui antialiased">
        <RootProviders>{children}</RootProviders>
      </body>
    </html>
  );
}
