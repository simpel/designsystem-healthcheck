import { watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiPath = resolve(__dirname, "ui.html");

console.log("[watch-ui] watching ui.html for changes...");

watch(uiPath, () => {
  try {
    execFileSync("node", [resolve(__dirname, "build-ui.mjs")], {
      stdio: "inherit",
    });
  } catch {
    // build-ui.mjs already logs errors
  }
});
