import { defineConfig } from "drizzle-kit";

// `generate` never connects, so DATABASE_URL is only needed for `studio` / `push`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts", // db/ephemeral.ts (UNLOGGED table) is deliberately NOT listed here
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres" },
  strict: true,
  verbose: true,
});
