import { watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiPath = resolve(__dirname, "ui.html");
const cssPath = resolve(__dirname, "ui.css");

console.log("[watch-ui] watching ui.html and ui.css for changes...");

function rebuild() {
  try {
    execFileSync("node", [resolve(__dirname, "build-ui.mjs")], {
      stdio: "inherit",
    });
  } catch {
    // build-ui.mjs already logs errors
  }
}

watch(uiPath, rebuild);
watch(cssPath, rebuild);
