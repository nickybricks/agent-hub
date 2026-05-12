import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agent Hub",
  description: "Unified dashboard for AI agents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Inline script to prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem('theme');
                  if (t === 'dark') document.documentElement.classList.add('dark');
                  else if (t === 'light') document.documentElement.classList.add('light');
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <nav className="border-b border-border bg-card shadow-sm shadow-shadow">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-accent rounded-lg flex items-center justify-center text-white font-bold text-sm shadow-sm">
                A
              </div>
              <span className="text-lg font-semibold text-foreground">
                Agent Hub
              </span>
            </Link>
            <div className="flex items-center gap-5">
              <div className="flex items-center gap-5 text-sm text-muted">
                <Link
                  href="/"
                  className="hover:text-foreground transition-colors"
                >
                  Dashboard
                </Link>
                <Link
                  href="/mail-analyzer"
                  className="hover:text-foreground transition-colors"
                >
                  Mail Analyzer
                </Link>
              </div>
              <div className="w-px h-5 bg-border" />
              <ThemeToggle />
            </div>
          </div>
        </nav>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
