import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const extensionPath = path.join(repoRoot, "vscode-extension");
const args = ["--extensionDevelopmentPath", extensionPath];

const child = spawn("code", args, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error(`Failed to launch VS Code with 'code': ${error.message}`);
  console.error("Install the VS Code shell command or use F5 with .vscode/launch.json.");
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
