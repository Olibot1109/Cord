#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_URL = "https://e.vapp.uk/";
const DEFAULT_FILE = "old-firebase.json";
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
};

function paint(text, color) {
  if (!process.stdout.isTTY || !ANSI[color]) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function now() {
  return new Date().toISOString();
}

function logInfo(message, meta = "") {
  const line = `${paint(now(), "dim")} ${paint("INFO", "cyan")} ${message}${meta ? ` ${paint("|", "gray")} ${meta}` : ""}`;
  console.log(line);
}

function logWarn(message, meta = "") {
  const line = `${paint(now(), "dim")} ${paint("WARN", "yellow")} ${message}${meta ? ` ${paint("|", "gray")} ${meta}` : ""}`;
  console.warn(line);
}

function logError(message, meta = "") {
  const line = `${paint(now(), "dim")} ${paint("ERROR", "red")} ${message}${meta ? ` ${paint("|", "gray")} ${meta}` : ""}`;
  console.error(line);
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    file: DEFAULT_FILE,
    force: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) {
      args.url = argv[++i];
    } else if (arg === "--host" && argv[i + 1]) {
      const host = argv[++i];
      args.url = `http://${host}:3000`;
    } else if (arg === "--port" && argv[i + 1]) {
      const port = Number(argv[++i]);
      const base = new URL(args.url);
      base.port = String(port);
      args.url = base.toString();
    } else if (arg === "--file" && argv[i + 1]) {
      args.file = argv[++i];
    } else if (arg === "--force") {
      args.force = true;
    }
  }

  return args;
}

async function httpRequest(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      payload = {};
    }
    return { ok: res.ok, status: res.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flattenToOps(value, basePath = "") {
  const ops = [];

  const walk = (node, currentPath) => {
    if (Array.isArray(node)) {
      ops.push({ path: currentPath, value: node });
      return;
    }
    if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0) {
        ops.push({ path: currentPath, value: {} });
        return;
      }
      keys.forEach((key) => {
        const nextPath = currentPath ? `${currentPath}/${key}` : key;
        walk(node[key], nextPath);
      });
      return;
    }
    ops.push({ path: currentPath, value: node });
  };

  walk(value, basePath);
  return ops;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(process.cwd(), args.file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  logInfo("Reading source file", `file=${filePath}`);
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  logInfo("Parsed JSON", `bytes=${raw.length}`);

  const ops = flattenToOps(json, "");
  logInfo("Prepared sequential operations", `count=${ops.length}`);
  const endpoint = String(args.url).replace(/\/+$/, "");

  if (!args.force) {
    logWarn("Dry run only", `endpoint=${endpoint}`);
    logWarn("Import will clear remote DB root and write entries one-by-one");
    logInfo("Re-run with --force to execute");
    return;
  }

  logInfo("Using HTTPS DB API", `endpoint=${endpoint}`);

  const startedAt = Date.now();
  logWarn("Clearing remote root before import", "path=<root>");
  const clearResponse = await httpRequest(`${endpoint}/api/db?path=`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: {} })
  }, 20000);
  if (!clearResponse.ok) {
    throw new Error(`Clear root failed: HTTP ${clearResponse.status} ${clearResponse.payload?.error || ""}`.trim());
  }
  logInfo("Remote root cleared");

  let okCount = 0;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    const pathLabel = op.path || "<root>";
    const opStart = Date.now();
    logInfo(`Write ${i + 1}/${ops.length}`, `path=${pathLabel}`);
    // Sequential write, one by one.
    const response = await httpRequest(`${endpoint}/api/db?path=${encodeURIComponent(op.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: op.value })
    }, 30000);
    if (!response.ok) {
      throw new Error(`Write failed at ${pathLabel}: HTTP ${response.status} ${response.payload?.error || ""}`.trim());
    }
    okCount += 1;
    logInfo(`Write complete ${i + 1}/${ops.length}`, `path=${pathLabel} durationMs=${Date.now() - opStart}`);
  }

  logInfo("Import finished", `success=${okCount}/${ops.length} totalDurationMs=${Date.now() - startedAt}`);
  console.log(paint(`Imported ${filePath} to ${endpoint}`, "green"));
}

main().catch((error) => {
  logError("Import failed", error.message || String(error));
  process.exit(1);
});
