import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents is deliberately off: every dashboard page is per-user and
  // dynamic, and default rendering is simpler to reason about (and explain).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
