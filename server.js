const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { Server: SocketServer } = require("socket.io");

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
let io = null;
let requestCounter = 0;
let socketRpcCounter = 0;
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

function withRpcLogging(socket, eventName, handler) {
  socket.on(eventName, async (payload, ack) => {
    const rpcId = ++socketRpcCounter;
    const start = Date.now();
    log("debug", "socket.rpc.start", {
      rpcId,
      socketId: socket.id,
      event: eventName,
      payload: payloadSummary(payload)
    });
    try {
      const result = await handler(payload);
      const response = result && typeof result === "object" ? result : { ok: true };
      if (typeof ack === "function") ack(response);
      log(response.ok === false ? "warn" : "info", "socket.rpc.finish", {
        rpcId,
        socketId: socket.id,
        event: eventName,
        ok: response.ok !== false,
        durationMs: Date.now() - start,
        response: payloadSummary(response)
      });
    } catch (error) {
      const response = { ok: false, error: error?.message || "RPC error" };
      if (typeof ack === "function") ack(response);
      log("error", "socket.rpc.error", {
        rpcId,
        socketId: socket.id,
        event: eventName,
        durationMs: Date.now() - start,
        error: error?.message || String(error),
        stack: error?.stack || null
      });
    }
  });
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
    emitDbChanged("");
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
  emitDbChanged(normalized);
}

function deleteByPath(inputPath) {
  const normalized = normalizePath(inputPath);
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = {};
    log("warn", "db.remove.root", { path: "" });
    scheduleSave();
    emitDbChanged("");
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
    emitDbChanged(normalized);
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

function emitDbChanged(changedPath) {
  if (!io) return;
  const normalizedPath = normalizePath(changedPath);
  log("info", "socket.broadcast.db_changed", { path: normalizedPath, connectedClients: io.engine.clientsCount });
  io.emit("db:changed", {
    path: normalizedPath,
    at: Date.now()
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
io = new SocketServer(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  const remoteAddress = socket.handshake?.address || null;
  log("info", "socket.connected", { socketId: socket.id, remoteAddress, connectedClients: io.engine.clientsCount });

  socket.on("disconnect", (reason) => {
    log("info", "socket.disconnected", { socketId: socket.id, reason, connectedClients: io.engine.clientsCount });
  });

  socket.on("error", (error) => {
    log("error", "socket.error", { socketId: socket.id, error: error?.message || String(error) });
  });

  withRpcLogging(socket, "auth:anonymous", (payload) => {
    const uid = payload && typeof payload.uid === "string" && payload.uid.trim()
      ? payload.uid
      : `u_${crypto.randomUUID().replace(/-/g, "")}`;
    log("debug", "socket.auth.anonymous", {
      socketId: socket.id,
      reusedUid: !!(payload && typeof payload.uid === "string" && payload.uid.trim()),
      issuedUid: uid
    });
    return { ok: true, uid };
  });

  withRpcLogging(socket, "db:get", (payload) => {
    const targetPath = normalizePath(payload?.path || "");
    log("debug", "socket.db.get", { socketId: socket.id, path: targetPath });
    return { ok: true, value: getByPath(targetPath) };
  });

  withRpcLogging(socket, "db:set", (payload) => {
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "value")) {
      log("warn", "socket.db.set.invalid_payload", { socketId: socket.id, summary: payloadSummary(payload) });
      return { ok: false, error: "Missing value" };
    }
    log("debug", "socket.db.set", { socketId: socket.id, path: normalizePath(payload.path || ""), summary: payloadSummary(payload.value) });
    setByPath(payload.path || "", payload.value);
    return { ok: true };
  });

  withRpcLogging(socket, "db:update", (payload) => {
    if (!payload || typeof payload.value !== "object" || payload.value == null || Array.isArray(payload.value)) {
      log("warn", "socket.db.update.invalid_payload", { socketId: socket.id, summary: payloadSummary(payload) });
      return { ok: false, error: "PATCH expects object value" };
    }
    log("debug", "socket.db.update", { socketId: socket.id, path: normalizePath(payload.path || ""), summary: payloadSummary(payload.value) });
    updateByPath(payload.path || "", payload.value);
    return { ok: true };
  });

  withRpcLogging(socket, "db:remove", (payload) => {
    log("debug", "socket.db.remove", { socketId: socket.id, path: normalizePath(payload?.path || "") });
    deleteByPath(payload?.path || "");
    return { ok: true };
  });

  withRpcLogging(socket, "db:updateRoot", (payload) => {
    if (!payload || typeof payload.updates !== "object" || payload.updates == null) {
      log("warn", "socket.db.updateRoot.invalid_payload", { socketId: socket.id, summary: payloadSummary(payload) });
      return { ok: false, error: "Missing updates" };
    }
    log("debug", "socket.db.updateRoot", {
      socketId: socket.id,
      pathCount: Object.keys(payload.updates).length,
      paths: Object.keys(payload.updates).slice(0, 50)
    });
    updateRoot(payload.updates);
    return { ok: true };
  });

  log("info", "socket.initial_sync", { socketId: socket.id });
  socket.emit("db:changed", { path: "", at: Date.now() });
});

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
  log("warn", "process.shutdown.begin", { signal, connectedClients: io?.engine?.clientsCount ?? 0 });
  flushSaveSync(`signal:${signal}`);
  try {
    io?.close();
  } catch (error) {
    log("error", "process.shutdown.io_close_failed", { signal, error: error.message });
  }
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
