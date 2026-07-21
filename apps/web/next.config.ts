import type { NextConfig } from "next";

const harnessDistDir = process.env.ARCHITECT_NEXT_DIST_DIR;

const nextConfig: NextConfig = {
  ...(harnessDistDir ? { distDir: harnessDistDir } : {}),
  transpilePackages: ["@architect/contracts", "@architect/ui"],
  async rewrites() {
    const serverUrl = process.env.ARCHITECT_SERVER_URL ?? "http://127.0.0.1:3001";
    return [
      {
        source: "/api/:path*",
        destination: `${serverUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
