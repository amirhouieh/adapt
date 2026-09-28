import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const betterSqliteStub = new URL(
  "./lib/noop-better-sqlite3.ts",
  import.meta.url,
).pathname;

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: {
    root: import.meta.dirname,
    resolveAlias: {
      "better-sqlite3": "./lib/noop-better-sqlite3.ts",
    },
  },
  webpack(config, { isServer }) {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "better-sqlite3": betterSqliteStub,
      };
    }

    return config;
  },
};

export default withMDX(config);
