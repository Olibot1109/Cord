const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

let db = {};
let saveTimer = null;
let requestCounter = 0;
const COLORS_ENABLED = process.stdout.isTTY && process.env.NO_COLOR !== "1";
const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};
const ACTIVE_LOG_WEIGHT = LOG_LEVEL_WEIGHT[LOG_LEVEL] ?? LOG_LEVEL_WEIGHT.info;
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
};

function paint(text, color) {
  if (!COLORS_ENABLED || !ANSI[color]) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function stringifyMetaValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const raw = JSON.stringify(value);
    return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
  } catch {
    return "[unserializable]";
  }
}

function formatMeta(meta) {
  const keys = Object.keys(meta || {});
  if (!keys.length) return "";
  return keys.map((key) => `${paint(key, "gray")}=${stringifyMetaValue(meta[key])}`).join(" ");
}

function shouldLog(level) {
  const weight = LOG_LEVEL_WEIGHT[String(level || "info").toLowerCase()] ?? LOG_LEVEL_WEIGHT.info;
  return weight >= ACTIVE_LOG_WEIGHT && ACTIVE_LOG_WEIGHT < LOG_LEVEL_WEIGHT.silent;
}

function log(level, message, meta = {}) {
  if (!shouldLog(level)) return;
  const ts = paint(new Date().toISOString(), "dim");
  const levelUpper = String(level || "info").toUpperCase();
  const levelColor = level === "error" ? "red" : level === "warn" ? "yellow" : level === "debug" ? "blue" : "cyan";
  const levelLabel = paint(levelUpper.padEnd(5), levelColor);
  const msg = paint(message, level === "error" ? "red" : level === "warn" ? "yellow" : "reset");
  const metaLine = formatMeta(meta);
  const line = metaLine ? `${ts} ${levelLabel} ${msg} ${paint("|", "gray")} ${metaLine}` : `${ts} ${levelLabel} ${msg}`;
  if (level === "error" || level === "warn") {
    console.error(line);
    return;
  }
  console.log(line);
}

function flushSaveSync(reason = "manual") {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const serialized = JSON.stringify(db, null, 2);
    fs.writeFileSync(DATA_FILE, serialized);
    log("warn", "db.save.flushed_sync", { reason, file: DATA_FILE, bytes: Buffer.byteLength(serialized) });
  } catch (error) {
    log("error", "db.save.flush_failed", { reason, file: DATA_FILE, error: error.message });
  }
}

function payloadSummary(value) {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 20), keyCount: Object.keys(value).length };
  if (typeof value === "string") return { type: "string", length: value.length };
  return { type: typeof value, value };
}

function normalizePath(inputPath) {
  if (inputPath == null) return "";
  return String(inputPath).replace(/^\/+|\/+$/g, "");
}

function splitPath(inputPath) {
  const clean = normalizePath(inputPath);
  return clean ? clean.split("/") : [];
}

function safeClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function resolveServerValue(value) {
  if (value && typeof value === "object") {
    if (value[".sv"] === "timestamp") {
      return Date.now();
    }
    if (Array.isArray(value)) {
      return value.map(resolveServerValue);
    }
    const next = {};
    Object.keys(value).forEach((key) => {
      next[key] = resolveServerValue(value[key]);
    });
    return next;
  }
  return value;
}

function getByPath(inputPath) {
  const parts = splitPath(inputPath);
  let node = db;
  for (const part of parts) {
    if (node == null || typeof node !== "object" || !(part in node)) {
      log("info", "db.get.miss", { path: normalizePath(inputPath) });
      return null;
    }
    node = node[part];
  }
  log("info", "db.get.hit", { path: normalizePath(inputPath), summary: payloadSummary(node) });
  return safeClone(node);
}

function setByPath(inputPath, value) {
  const normalized = normalizePath(inputPath);
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = resolveServerValue(value) ?? {};
    log("warn", "db.set.root", { path: "", summary: payloadSummary(value) });
    scheduleSave();
    return;
  }
  let node = db;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (node[part] == null || typeof node[part] !== "object" || Array.isArray(node[part])) {
      node[part] = {};
    }
    node = node[part];
  }
  node[parts[parts.length - 1]] = resolveServerValue(value);
  log("info", "db.set", { path: normalized, summary: payloadSummary(value) });
  scheduleSave();
}

function deleteByPath(inputPath) {
  const normalized = normalizePath(inputPath);
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = {};
    log("warn", "db.remove.root", { path: "" });
    scheduleSave();
    return;
  }
  let node = db;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (node == null || typeof node !== "object" || !(part in node)) return;
    node = node[part];
  }
  if (node && typeof node === "object") {
    delete node[parts[parts.length - 1]];
    log("info", "db.remove", { path: normalized });
    scheduleSave();
  }
}

function updateByPath(inputPath, patch) {
  const current = getByPath(inputPath);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const next = { ...base };
  const incoming = patch && typeof patch === "object" ? patch : {};
  Object.keys(incoming).forEach((key) => {
    next[key] = resolveServerValue(incoming[key]);
  });
  log("info", "db.update", { path: normalizePath(inputPath), summary: payloadSummary(patch) });
  setByPath(inputPath, next);
}

function updateRoot(updates) {
  const payload = updates && typeof updates === "object" ? updates : {};
  log("warn", "db.updateRoot", { paths: Object.keys(payload).slice(0, 50), pathCount: Object.keys(payload).length });
  Object.keys(payload).forEach((key) => {
    const value = payload[key];
    if (value === null || value === undefined) {
      deleteByPath(key);
      return;
    }
    setByPath(key, value);
  });
}

function createPushKey() {
  const now = Date.now().toString(36).padStart(10, "0");
  const rand = crypto.randomBytes(5).toString("hex");
  return `-${now}${rand}`;
}

function sanitizeStaticPath(urlPathname) {
  const pathname = urlPathname === "/" ? "/index.html" : urlPathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  return path.join(ROOT_DIR, safePath);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  log("info", "db.save.scheduled", { delayMs: 75 });
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    log("info", "db.save.completed", { file: DATA_FILE, bytes: Buffer.byteLength(JSON.stringify(db)) });
  }, 75);
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      db = parsed;
      log("info", "db.load.completed", { file: DATA_FILE, bytes: Buffer.byteLength(raw) });
    }
  } catch (error) {
    db = {};
    log("warn", "db.load.fallback_empty", { file: DATA_FILE, reason: error.message });
  }
}

function decodeJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function handleApi(req, res, reqUrl, requestId) {
  if (req.method === "POST" && reqUrl.pathname === "/api/auth/anonymous") {
    const body = await decodeJsonBody(req).catch(() => ({}));
    const uid = body.uid && typeof body.uid === "string" && body.uid.trim()
      ? body.uid
      : `u_${crypto.randomUUID().replace(/-/g, "")}`;
    log("info", "api.auth.anonymous", { requestId, reusedUid: !!(body.uid && String(body.uid).trim()), uid });
    respondJson(res, 200, { uid });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/db") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    log("debug", "api.db.get", { requestId, path: targetPath });
    respondJson(res, 200, { value: getByPath(targetPath) });
    return true;
  }

  if (req.method === "PUT" && reqUrl.pathname === "/api/db") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    const body = await decodeJsonBody(req).catch(() => null);
    if (!body || !Object.prototype.hasOwnProperty.call(body, "value")) {
      respondJson(res, 400, { error: "Missing value" });
      return true;
    }
    log("debug", "api.db.set", { requestId, path: targetPath, summary: payloadSummary(body.value) });
    setByPath(targetPath, body.value);
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "PATCH" && reqUrl.pathname === "/api/db") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    const body = await decodeJsonBody(req).catch(() => null);
    if (!body || typeof body.value !== "object" || body.value == null || Array.isArray(body.value)) {
      respondJson(res, 400, { error: "PATCH expects object value" });
      return true;
    }
    log("debug", "api.db.update", { requestId, path: targetPath, summary: payloadSummary(body.value) });
    updateByPath(targetPath, body.value);
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "DELETE" && reqUrl.pathname === "/api/db") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    log("debug", "api.db.remove", { requestId, path: targetPath });
    deleteByPath(targetPath);
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/db/update-root") {
    const body = await decodeJsonBody(req).catch(() => null);
    if (!body || typeof body.updates !== "object" || body.updates == null) {
      respondJson(res, 400, { error: "Missing updates" });
      return true;
    }
    log("warn", "api.db.updateRoot", { requestId, pathCount: Object.keys(body.updates).length });
    updateRoot(body.updates);
    respondJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function requestHandler(req, res) {
  const requestId = ++requestCounter;
  const start = Date.now();
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    log("info", "http.request.start", {
      requestId,
      method: req.method,
      path: reqUrl.pathname,
      userAgent: req.headers["user-agent"] || null
    });

    if (reqUrl.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, reqUrl, requestId);
      if (!handled) {
        respondJson(res, 404, { error: "Not found" });
      }
      return;
    }

    const filePath = sanitizeStaticPath(reqUrl.pathname);
    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      log("warn", "http.request.forbidden", { requestId, path: reqUrl.pathname });
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      log("warn", "http.request.not_found", { requestId, path: reqUrl.pathname, filePath });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const size = fs.statSync(filePath).size;
    log("info", "http.request.serve_file", { requestId, path: reqUrl.pathname, filePath, mime, size });
    res.writeHead(200, { "Content-Type": mime });
    const stream = fs.createReadStream(filePath);
    stream.on("error", (error) => {
      log("error", "http.stream.error", { requestId, filePath, error: error.message });
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("Internal server error");
    });
    stream.pipe(res);
    res.on("finish", () => {
      log("info", "http.request.finish", {
        requestId,
        method: req.method,
        path: reqUrl.pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - start
      });
    });
  } catch (error) {
    log("error", "http.request.error", { requestId, error: error.message, stack: error.stack });
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
}

loadData();

const server = http.createServer(requestHandler);

server.listen(PORT, HOST, () => {
  log("info", "server.started", {
    host: HOST,
    port: PORT,
    rootDir: ROOT_DIR,
    dataFile: DATA_FILE,
    pid: process.pid,
    node: process.version,
    logLevel: LOG_LEVEL
  });
});

server.on("error", (error) => {
  log("error", "server.error", { error: error.message, stack: error.stack });
});

process.on("uncaughtException", (error) => {
  log("error", "process.uncaughtException", { error: error.message, stack: error.stack });
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log("error", "process.unhandledRejection", { error: error.message, stack: error.stack });
});

function shutdown(signal) {
  log("warn", "process.shutdown.begin", { signal });
  flushSaveSync(`signal:${signal}`);
  server.close((error) => {
    if (error) {
      log("error", "process.shutdown.server_close_failed", { signal, error: error.message });
      process.exit(1);
      return;
    }
    log("warn", "process.shutdown.complete", { signal });
    process.exit(0);
  });
  setTimeout(() => {
    log("error", "process.shutdown.timeout_forced_exit", { signal, timeoutMs: 3000 });
    process.exit(1);
  }, 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
