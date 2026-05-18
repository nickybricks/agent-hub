import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // The /app split-screen shell is the only canonical surface now. The old
  // /mail-analyzer/* pages are fully superseded — 308 them to /app. API routes
  // live under /api/mail-analyzer/* and never match these sources.
  async redirects() {
    return [
      { source: "/mail-analyzer", destination: "/app", permanent: true },
      { source: "/mail-analyzer/:path*", destination: "/app", permanent: true },
    ];
  },
};

export default nextConfig;
