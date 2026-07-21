import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@architect/contracts", "@architect/ui"],
};

export default nextConfig;
