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
      return null;
    }
    node = node[part];
  }
  return safeClone(node);
}

function setByPath(inputPath, value) {
  const normalized = normalizePath(inputPath);
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = resolveServerValue(value) ?? {};
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
  scheduleSave();
  emitDbChanged(normalized);
}

function deleteByPath(inputPath) {
  const normalized = normalizePath(inputPath);
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = {};
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
  setByPath(inputPath, next);
}

function updateRoot(updates) {
  const payload = updates && typeof updates === "object" ? updates : {};
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
  io.emit("db:changed", {
    path: normalizePath(changedPath),
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
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }, 75);
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      db = parsed;
    }
  } catch {
    db = {};
  }
}

async function requestHandler(req, res) {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

    const filePath = sanitizeStaticPath(reqUrl.pathname);
    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
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
  socket.on("auth:anonymous", (payload, ack) => {
    const uid = payload && typeof payload.uid === "string" && payload.uid.trim()
      ? payload.uid
      : `u_${crypto.randomUUID().replace(/-/g, "")}`;
    if (typeof ack === "function") {
      ack({ ok: true, uid });
    }
  });

  socket.on("db:get", (payload, ack) => {
    const targetPath = normalizePath(payload?.path || "");
    if (typeof ack === "function") {
      ack({ ok: true, value: getByPath(targetPath) });
    }
  });

  socket.on("db:set", (payload, ack) => {
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "value")) {
      if (typeof ack === "function") ack({ ok: false, error: "Missing value" });
      return;
    }
    setByPath(payload.path || "", payload.value);
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("db:update", (payload, ack) => {
    if (!payload || typeof payload.value !== "object" || payload.value == null || Array.isArray(payload.value)) {
      if (typeof ack === "function") ack({ ok: false, error: "PATCH expects object value" });
      return;
    }
    updateByPath(payload.path || "", payload.value);
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("db:remove", (payload, ack) => {
    deleteByPath(payload?.path || "");
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("db:updateRoot", (payload, ack) => {
    if (!payload || typeof payload.updates !== "object" || payload.updates == null) {
      if (typeof ack === "function") ack({ ok: false, error: "Missing updates" });
      return;
    }
    updateRoot(payload.updates);
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.emit("db:changed", { path: "", at: Date.now() });
});

server.listen(PORT, HOST, () => {
  console.log(`Cord server running at http://${HOST}:${PORT}`);
});
