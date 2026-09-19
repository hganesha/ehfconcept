import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  webpack(config) {
    // Workspace packages use NodeNext-compatible `.js` specifiers in their
    // TypeScript sources. Resolve those specifiers to source files while the
    // application is bundled; emitted package builds still resolve as native
    // ESM at runtime.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
