import type { NextConfig } from "next";

const milestone2DistDir = ".milestone2-next";
const harnessDistDir = process.env.ARCHITECT_NEXT_DIST_DIR;
if (harnessDistDir !== undefined && harnessDistDir !== milestone2DistDir) {
  throw new Error(
    'ARCHITECT_NEXT_DIST_DIR must be ".milestone2-next" when set',
  );
}

const nextConfig: NextConfig = {
  ...(harnessDistDir === milestone2DistDir
    ? { distDir: milestone2DistDir }
    : {}),
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
