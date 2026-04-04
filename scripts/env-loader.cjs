const fs = require("node:fs");
const path = require("node:path");

function loadProjectEnv(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const files = Array.isArray(options.files) && options.files.length
    ? options.files
    : [".env", ".env.local"];
  const override = options.override === true;

  for (const relativeFile of files) {
    const filePath = path.resolve(root, relativeFile);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      applyEnvContent(content, override);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Failed to load env file ${filePath}`, error);
      }
    }
  }
}

function applyEnvContent(content, override) {
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

module.exports = {
  loadProjectEnv,
};
