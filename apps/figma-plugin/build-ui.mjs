import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env file — .env.production if NODE_ENV=production, else .env
const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env";
config({ path: resolve(__dirname, envFile) });

const WORKER_URL = process.env.WORKER_URL;
const MODEL = process.env.MODEL;
if (!WORKER_URL) {
  console.error(`Missing WORKER_URL in ${envFile}`);
  process.exit(1);
}
if (!MODEL) {
  console.error(`Missing MODEL in ${envFile}`);
  process.exit(1);
}

// Read template, replace placeholders, write output
const template = readFileSync(resolve(__dirname, "ui.html"), "utf-8");
const output = template
  .replace(
    /const WORKER_URL\s*=\s*"[^"]*"/,
    `const WORKER_URL = "${WORKER_URL}"`
  )
  .replace(
    /const MODEL\s*=\s*"[^"]*"/,
    `const MODEL      = "${MODEL}"`
  );

mkdirSync(resolve(__dirname, "dist"), { recursive: true });
writeFileSync(resolve(__dirname, "dist/ui.html"), output);
console.log(`[build-ui] ${envFile} → WORKER_URL=${WORKER_URL}, MODEL=${MODEL}`);
