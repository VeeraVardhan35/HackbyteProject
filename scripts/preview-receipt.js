const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadProjectEnv } = require("./env-loader.cjs");

loadProjectEnv(path.resolve(__dirname, ".."));

const backendUrl = process.env.COMMIT_CONFESSIONAL_RECEIPT_URL || "http://127.0.0.1:4000/api/receipt";
const DEFAULT_PREVIEW_RANGE = normalizeConfiguredPreviewRange(process.env.COMMIT_CONFESSIONAL_PREVIEW_RANGE);
const UNTRACKED_PREVIEW_MAX_BYTES = 256 * 1024;

async function main() {
  const repoRoot = process.cwd();
  const request = parseArgs(process.argv.slice(2));
  const targetPath = request.targetPath;
  const commitRange = request.commitRange || DEFAULT_PREVIEW_RANGE;
  const diffText = commitRange
    ? buildCommitRangeDiff(repoRoot, commitRange, targetPath)
    : buildPreviewDiff(repoRoot, targetPath);

  if (!diffText.trim()) {
    console.log(
      commitRange
        ? `No diff found for range ${commitRange}.`
        : targetPath
          ? `No staged or working-tree diff found for ${targetPath}.`
          : "No staged or working-tree diff found."
    );
    if (commitRange && !request.commitRange) {
      const fallbackDiff = buildPreviewDiff(repoRoot, targetPath);
      if (fallbackDiff.trim()) {
        console.log("Falling back to staged + working-tree diff.");
        return await runPreviewWithDiff(fallbackDiff, targetPath, null);
      }
    }
    return;
  }

  if (commitRange) {
    console.log(`Preview scope: range=${commitRange}${targetPath ? ` file=${targetPath}` : ""}`);
  } else if (targetPath) {
    console.log(`Preview scope: file=${targetPath}`);
  }

  const summary = summarizeDiff(diffText);
  console.log(
    `Diff summary: files=${summary.filesChanged} added=${summary.addedLines} removed=${summary.removedLines} net=${summary.netLines}`
  );
  const localShareAll = computeLocalAiShare(diffText, repoRoot, { includeEmpty: true, meaningfulOnly: false });
  console.log(
    `Local AI share (all added lines): total=${localShareAll.totalCount} ai=${localShareAll.aiTagged} human=${localShareAll.humanTagged} unknown=${localShareAll.unknownTagged} aiPct=${localShareAll.aiPct}% humanPct=${localShareAll.humanPct}%`
  );
  const localShareMeaningful = computeLocalAiShare(diffText, repoRoot, { includeEmpty: false, meaningfulOnly: true });
  if (localShareMeaningful.totalCount > 0) {
    console.log(
      `Local AI share (meaningful lines): total=${localShareMeaningful.totalCount} ai=${localShareMeaningful.aiTagged} human=${localShareMeaningful.humanTagged} unknown=${localShareMeaningful.unknownTagged} aiPct=${localShareMeaningful.aiPct}% humanPct=${localShareMeaningful.humanPct}%`
    );
  } else {
    console.log("Local AI share (meaningful lines): no meaningful added lines to score.");
  }

  await runPreviewWithDiff(diffText, targetPath, commitRange);
}

function execGit(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

function buildPreviewDiff(repoRoot, targetPath = null) {
  const diffArgs = targetPath ? ["--", targetPath] : [];
  const stagedDiff = execGit(["diff", "--cached", "--unified=0", ...diffArgs], repoRoot);
  const workingDiff = execGit(["diff", "--unified=0", ...diffArgs], repoRoot);
  // Untracked files need a synthetic diff because git diff omits them by default.
  const untrackedDiffs = readUntrackedFileDiffs(repoRoot, targetPath ? [targetPath] : null);
  return [stagedDiff, workingDiff, ...untrackedDiffs].filter(Boolean).join("\n");
}

function buildCommitRangeDiff(repoRoot, commitRange, targetPath = null) {
  const diffArgs = targetPath ? ["--", targetPath] : [];
  return execGit(["diff", "--unified=0", commitRange, ...diffArgs], repoRoot);
}

function readUntrackedFileDiffs(repoRoot, onlyPaths = null) {
  const output = execGit(["ls-files", "--others", "--exclude-standard"], repoRoot);
  const filePaths = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const filterPaths = onlyPaths ? new Set(onlyPaths.map(normalizeRepoPath)) : null;
  const diffs = [];

  for (const relativePath of filePaths) {
    const normalizedPath = normalizeRepoPath(relativePath);
    if (filterPaths && !filterPaths.has(normalizedPath)) {
      continue;
    }

    const fullPath = path.join(repoRoot, relativePath);
    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (!stats.isFile() || stats.size > UNTRACKED_PREVIEW_MAX_BYTES) {
      continue;
    }

    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    if (content.includes("\u0000")) {
      continue;
    }

    diffs.push(createUntrackedFileDiff(normalizedPath, content));
  }

  return diffs;
}

function createUntrackedFileDiff(filePath, content) {
  const normalizedPath = normalizeRepoPath(filePath);
  const lines = String(content || "").replace(/\r/g, "").split("\n");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function parseArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { commitRange: null, targetPath: null };
  }

  if (args.length > 2) {
    throw new Error("Pass at most two arguments: [commit-range] [file-path-or-file-name].");
  }

  const normalized = args.map((value) => String(value || "").trim()).filter(Boolean);
  if (normalized.length === 0) {
    return { commitRange: null, targetPath: null };
  }

  if (normalized.some((value) => value === "--help" || value === "-h")) {
    printUsage();
    process.exit(0);
  }

  const rangeArg = normalized.find((value) => value.includes("..")) || null;
  const fileArg = normalized.find((value) => value !== rangeArg) || null;
  const commitRange = rangeArg ? normalizeRange(rangeArg) : null;
  const targetPath = fileArg ? resolveRequestedFile(process.cwd(), fileArg) : null;

  return { commitRange, targetPath };
}

function resolveRequestedFile(repoRoot, request) {
  if (!request) {
    return null;
  }

  const exactPath = resolveExactFileTarget(repoRoot, request);
  if (exactPath) {
    return exactPath;
  }

  const repoFiles = listRepoFiles(repoRoot);
  const normalizedRequest = normalizeRepoPath(request).toLowerCase();
  const exactRepoMatch = repoFiles.find((filePath) => filePath.toLowerCase() === normalizedRequest);
  if (exactRepoMatch) {
    return exactRepoMatch;
  }

  if (request.includes("/") || request.includes("\\") || path.isAbsolute(request)) {
    throw new Error(`Could not find "${request}" in this repository.`);
  }

  const baseName = path.basename(request).toLowerCase();
  const baseNameMatches = repoFiles.filter((filePath) => path.basename(filePath).toLowerCase() === baseName);

  if (baseNameMatches.length === 1) {
    return baseNameMatches[0];
  }

  if (baseNameMatches.length > 1) {
    throw new Error(
      `File name "${request}" is ambiguous. Use one of: ${baseNameMatches.join(", ")}`
    );
  }

  throw new Error(`Could not find "${request}" in this repository.`);
}

function normalizeRange(value) {
  return String(value || "").replace(/\.{2,}/, "..");
}

function normalizeConfiguredPreviewRange(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? normalizeRange(trimmed) : null;
}

function resolveExactFileTarget(repoRoot, request) {
  const candidatePath = path.resolve(repoRoot, request);
  if (!isFileWithinRepo(repoRoot, candidatePath)) {
    return null;
  }
  return normalizeRepoPath(path.relative(repoRoot, candidatePath));
}

function isFileWithinRepo(repoRoot, candidatePath) {
  try {
    const stats = fs.statSync(candidatePath);
    if (!stats.isFile()) {
      return false;
    }

    const relativePath = path.relative(repoRoot, candidatePath);
    return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  } catch {
    return false;
  }
}

function listRepoFiles(repoRoot) {
  const output = execGit(["ls-files", "--cached", "--others", "--exclude-standard"], repoRoot);
  return [...new Set(output.split(/\r?\n/).map((value) => normalizeRepoPath(value)).filter(Boolean))];
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function printUsage() {
  console.log("Usage: node scripts/preview-receipt.js [commit-range] [file-path-or-file-name]");
  console.log("Examples:");
  console.log("  node scripts/preview-receipt.js");
  console.log("  node scripts/preview-receipt.js vscode-extension/extension.js");
  console.log("  node scripts/preview-receipt.js HEAD~1..HEAD");
  console.log("  node scripts/preview-receipt.js HEAD~1..HEAD vscode-extension/extension.js");
  console.log("  node scripts/preview-receipt.js backend/src/server.js");
  console.log("  node scripts/preview-receipt.js demo-vulnerabilities.js");
  console.log("Env:");
  console.log("  COMMIT_CONFESSIONAL_PREVIEW_RANGE=HEAD~1..HEAD");
}

function countAddedLines(diffText) {
  const lines = diffText.split('\n');
  let addedLinesCount = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLinesCount++;
    }
  }
  return addedLinesCount;
}

function summarizeDiff(diffText) {
  let filesChanged = new Set();
  let addedLines = 0;
  let removedLines = 0;
  let currentFile = null;

  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const filePath = line.replace(/^(\+\+\+\s+)/, "").trim();
      if (filePath !== "/dev/null") {
        currentFile = normalizeRepoPath(filePath.replace(/^b\//, ""));
        filesChanged.add(currentFile);
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) addedLines += 1;
      continue;
    }
    if (line.startsWith("-")) {
      if (!line.startsWith("---")) removedLines += 1;
    }
  }

  return {
    filesChanged: filesChanged.size,
    addedLines,
    removedLines,
    netLines: addedLines - removedLines,
  };
}

function computeLocalAiShare(diffText, repoRoot, options = {}) {
  const { includeEmpty = false, meaningfulOnly = true } = options;
  const detectorPath = path.join(repoRoot, ".aidetector.json");
  let detector = null;
  try {
    detector = JSON.parse(fs.readFileSync(detectorPath, "utf8"));
  } catch {
    detector = { files: {} };
  }

  const tagIndex = new Map();
  for (const [filePath, fileState] of Object.entries(detector.files || {})) {
    if (!fileState?.lineTags) continue;
    const tags = new Map();
    for (const tag of fileState.lineTags) {
      if (tag?.hash) {
        tags.set(tag.hash, tag);
      }
    }
    tagIndex.set(normalizeRepoPath(filePath), tags);
  }

  const added = extractAddedLinesByFile(diffText);
  let total = 0;
  let ai = 0;
  let human = 0;
  let unknown = 0;

  for (const entry of added) {
    const line = String(entry.line ?? "");
    if (!includeEmpty && line.trim() === "") {
      continue;
    }
    if (meaningfulOnly && !isMeaningfulContentLine(line)) {
      continue;
    }
    const hash = hashContent(line);
    if (!hash) continue;
    total += 1;
    const tags = tagIndex.get(normalizeRepoPath(entry.filePath));
    const tag = tags?.get(hash);
    if (tag && tag.ai) {
      ai += 1;
    } else if (tag) {
      human += 1;
    } else {
      unknown += 1;
    }
  }

  const aiPct = total > 0 ? Math.round((ai / total) * 100) : 0;
  const humanPct = total > 0 ? Math.round((human / total) * 100) : 0;

  return {
    totalCount: total,
    aiTagged: ai,
    humanTagged: human,
    unknownTagged: unknown,
    aiPct,
    humanPct,
  };
}

function extractAddedLinesByFile(diffText) {
  const added = [];
  let currentFile = null;
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const filePath = line.replace(/^(\+\+\+\s+)/, "").trim();
      if (filePath === "/dev/null") {
        currentFile = null;
        continue;
      }
      currentFile = normalizeRepoPath(filePath.replace(/^b\//, ""));
      continue;
    }
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      continue;
    }
    if (currentFile && line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ filePath: currentFile, line: line.slice(1) });
    }
  }
  return added;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isMeaningfulContentLine(line) {
  const value = normalizeWhitespace(line);
  if (value.length < 15) {
    return false;
  }
  if (/^[{}()[\];,]+$/.test(value)) {
    return false;
  }
  if (/^(import|export|from|return|const|let|var|module\.exports)\b\s*[^=;]*;?$/i.test(value) && value.length < 30) {
    return false;
  }
  return true;
}

function hashContent(value) {
  const normalized = normalizeWhitespace(value);
  return normalized ? `sha256:${require("node:crypto").createHash("sha256").update(normalized).digest("hex")}` : null;
}

async function runPreviewWithDiff(diffText, targetPath, commitRange) {
  const addedLinesCount = countAddedLines(diffText);
  const payload = {
    diffText,
    receiptUrl: commitRange ? `preview://range/${commitRange}` : "preview://working-tree",
    targetPath: targetPath || null,
    newlyAddedLines: addedLinesCount,
  };

  try {
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.message || `Receipt request failed with ${response.status}`);
    }

    const evidence = body.modelEvidence || {};
    const contribution = evidence.contribution || {};
    const copilotContribution = body.copilotContribution || evidence.copilotContribution || {};
    const finalPercentage =
      Number(copilotContribution.estimatedAiPercentage ?? contribution.estimatedAiPercentage ?? 0) || 0;

    console.log(
      `Preview receipt: certainty=${evidence.certainty || "NONE"} model=${evidence.model || "unknown"} method=${evidence.method || "none"}`
    );
    console.log(`Final percentage: ${finalPercentage}%`);
    console.log(
      `Newly added lines: ${addedLinesCount}`
    );
    console.log(
      `Copilot contribution: matched=${copilotContribution.aiMatchedLines || 0}/${copilotContribution.totalChangedLines || 0} percentage=${copilotContribution.estimatedAiPercentage || 0}% confidence=${copilotContribution.confidenceLevel || "LOW"} events=${copilotContribution.eventCount || 0}`
    );
    if (copilotContribution.sampleTooSmall) {
      console.log("Copilot contribution sample is too small for a stable percentage.");
    }
    console.log(
      `AI contribution: matched=${contribution.aiMatchedLines || 0}/${contribution.totalChangedLines || 0} percentage=${contribution.estimatedAiPercentage || 0}% confidence=${contribution.confidenceLevel || "LOW"}`
    );
    if (contribution.sampleTooSmall) {
      console.log("AI contribution sample is too small for a stable percentage.");
    }

    if (Array.isArray(evidence.evidence) && evidence.evidence.length) {
      for (const line of evidence.evidence) {
        console.log(`- ${line}`);
      }
    }
  } catch (error) {
    console.error(`Preview receipt failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  buildPreviewDiff,
  listRepoFiles,
  normalizeRepoPath,
  resolveRequestedFile,
};
