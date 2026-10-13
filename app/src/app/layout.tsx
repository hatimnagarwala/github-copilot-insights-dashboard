import type { Metadata } from "next";
import localFont from "next/font/local";
import { Sidebar } from "@/components/layout/sidebar";
import { DemoModeBanner } from "@/components/layout/demo-mode-banner";
import { AuthGate } from "@/components/auth/auth-gate";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import { LocaleProvider } from "@/lib/i18n/locale-provider";
import "./globals.css";

// Primary UI typeface — GitHub's brand sans (Mona Sans), self-hosted and
// exposed as `--font-mona-sans`. Non-Latin scripts (e.g. Arabic) fall through
// per-glyph to the OS system sans stack defined in globals.css.
const monaSans = localFont({
  src: "./fonts/Mona-Sans.woff2",
  variable: "--font-mona-sans",
  display: "swap",
  weight: "200 900",
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Noto Sans",
    "Helvetica",
    "Arial",
    "sans-serif",
  ],
});

// Monospace typeface for code, identifiers, API paths, and tabular figures —
// GitHub's Monaspace (Neon), self-hosted and exposed as `--font-monaspace`.
const monaspace = localFont({
  src: "./fonts/Monaspace-Neon.woff2",
  variable: "--font-monaspace",
  display: "swap",
  weight: "200 800",
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "SF Mono",
    "Menlo",
    "Consolas",
    "Liberation Mono",
    "monospace",
  ],
});

export const metadata: Metadata = {
  title: "GitHub Copilot Insights",
  description:
    "Enterprise analytics dashboard for GitHub Copilot usage and impact",
  icons: {
    icon: [
      { url: "/copilot-insights-icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico" },
    ],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${monaSans.variable} ${monaspace.variable}`}
    >
      <body className="bg-gray-50 text-gray-900 antialiased dark:bg-gray-900 dark:text-gray-100">
        <ThemeProvider>
          <LocaleProvider>
            <AuthGate>
              <div className="flex h-screen">
                <Sidebar />
                <main className="flex flex-1 flex-col overflow-hidden">
                  <DemoModeBanner />
                  <div className="flex-1 overflow-y-auto p-6">{children}</div>
                </main>
              </div>
            </AuthGate>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
