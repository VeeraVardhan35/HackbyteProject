import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const extensionDir = path.join(repoRoot, "vscode-extension");
const extensionEntry = path.join(extensionDir, "extension.js");
const packageJsonPath = path.join(extensionDir, "package.json");

let pendingTimer = null;
let isRunning = false;
let rerunRequested = false;

async function validateExtension() {
  if (isRunning) {
    rerunRequested = true;
    return;
  }

  isRunning = true;
  rerunRequested = false;
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] validating vscode-extension`);

  try {
    await execFileAsync(process.execPath, ["--check", extensionEntry], { cwd: repoRoot });
    const rawPackage = await fs.promises.readFile(packageJsonPath, "utf8");
    JSON.parse(rawPackage);
    console.log("  ok: extension.js syntax and package.json parse");
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const message = stderr || error?.message || String(error);
    console.error(`  failed: ${message}`);
  } finally {
    isRunning = false;
    if (rerunRequested) {
      rerunRequested = false;
      queueValidation();
    }
  }
}

function queueValidation() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void validateExtension();
  }, 200);
}

console.log(`Watching ${extensionDir}`);
void validateExtension();

const watcher = fs.watch(extensionDir, { recursive: true }, (_eventType, fileName) => {
  const changedPath = String(fileName || "");
  if (!changedPath || changedPath.includes("node_modules") || changedPath.includes(".git")) {
    return;
  }
  console.log(`change detected: ${changedPath}`);
  queueValidation();
});

watcher.on("error", (error) => {
  console.error(`watch failed: ${error.message}`);
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  watcher.close();
  console.log("Stopped extension watcher.");
  process.exit(0);
});
