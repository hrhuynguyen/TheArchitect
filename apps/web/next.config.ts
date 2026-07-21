import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
