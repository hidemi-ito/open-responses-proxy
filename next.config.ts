import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Increase body size limit for file uploads (/v1/files)
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default nextConfig;
