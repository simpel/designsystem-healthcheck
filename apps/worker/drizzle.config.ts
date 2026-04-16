import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".dev.vars" });

const isRemote = !!process.env.CLOUDFLARE_D1_TOKEN;

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  ...(isRemote
    ? {
        driver: "d1-http",
        dbCredentials: {
          accountId: process.env.CF_ACCOUNT_ID!,
          databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
          token: process.env.CLOUDFLARE_D1_TOKEN!,
        },
      }
    : {
        dbCredentials: {
          url: process.env.LOCAL_DB_PATH!,
        },
      }),
});
