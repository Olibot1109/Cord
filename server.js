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

function normalizePath(inputPath) {
  if (inputPath == null) return "";
  return String(inputPath).replace(/^\/+|\/+$/g, "");
}

function splitPath(inputPath) {
  const clean = normalizePath(inputPath);
  return clean ? clean.split("/") : [];
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
  res.writeHead(statusCode, { "Content-Type": MIME_TYPES[".json"] });
  res.end(JSON.stringify(payload));
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
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = resolveServerValue(value) ?? {};
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
  scheduleSave();
}

function deleteByPath(inputPath) {
  const parts = splitPath(inputPath);
  if (parts.length === 0) {
    db = {};
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

async function handleApi(req, res, reqUrl) {
  if (req.method === "POST" && reqUrl.pathname === "/api/auth/anonymous") {
    const body = await decodeJsonBody(req).catch(() => ({}));
    const uid = body.uid && typeof body.uid === "string" ? body.uid : `u_${crypto.randomUUID().replace(/-/g, "")}`;
    respondJson(res, 200, { uid });
    return true;
  }

  if (reqUrl.pathname === "/api/db" && req.method === "GET") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    respondJson(res, 200, { value: getByPath(targetPath) });
    return true;
  }

  if (reqUrl.pathname === "/api/db" && req.method === "PUT") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    const body = await decodeJsonBody(req).catch(() => null);
    if (!body || !("value" in body)) {
      respondJson(res, 400, { error: "Missing value" });
      return true;
    }
    setByPath(targetPath, body.value);
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (reqUrl.pathname === "/api/db" && req.method === "PATCH") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    const body = await decodeJsonBody(req).catch(() => null);
    if (!body || typeof body.value !== "object" || Array.isArray(body.value) || body.value == null) {
      respondJson(res, 400, { error: "PATCH expects object value" });
      return true;
    }
    updateByPath(targetPath, body.value);
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (reqUrl.pathname === "/api/db" && req.method === "DELETE") {
    const targetPath = normalizePath(reqUrl.searchParams.get("path") || "");
    deleteByPath(targetPath);
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (reqUrl.pathname === "/api/db/update-root" && req.method === "POST") {
    const body = await decodeJsonBody(req).catch(() => null);
    if (!body || typeof body.updates !== "object" || body.updates == null) {
      respondJson(res, 400, { error: "Missing updates" });
      return true;
    }
    updateRoot(body.updates);
    respondJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function requestHandler(req, res) {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

    if (reqUrl.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, reqUrl);
      if (!handled) {
        respondJson(res, 404, { error: "Not found" });
      }
      return;
    }

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
    respondJson(res, 500, { error: "Internal server error" });
  }
}

loadData();

const server = http.createServer(requestHandler);
server.listen(PORT, HOST, () => {
  console.log(`Cord server running at http://${HOST}:${PORT}`);
});
