import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // required by the Dockerfile
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep Node-only libs out of the bundle.
  serverExternalPackages: ["pg", "pino", "prom-client"],
  // Tailwind v4 via its Turbopack loader (no postcss.config needed).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
