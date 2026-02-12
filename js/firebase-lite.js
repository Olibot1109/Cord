(() => {
  const SERVER_VALUE_TIMESTAMP = { ".sv": "timestamp" };
  const RPC_TIMEOUT_MS = 10000;

  function normalizePath(path) {
    if (path == null) return "";
    return String(path).replace(/^\/+|\/+$/g, "");
  }

  function splitPath(path) {
    const clean = normalizePath(path);
    return clean ? clean.split("/") : [];
  }

  function getLastSegment(path) {
    const parts = splitPath(path);
    return parts.length ? parts[parts.length - 1] : null;
  }

  function pathsOverlap(a, b) {
    const pa = normalizePath(a);
    const pb = normalizePath(b);
    if (!pa || !pb) return true;
    return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
  }

  function deepClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function sortedObjectEntries(obj) {
    return Object.keys(obj || {})
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, obj[key]]);
  }

  class SocketBridge {
    constructor(baseUrl) {
      this.baseUrl = baseUrl;
      this.connected = false;
      this.socket = null;
      this._connectListeners = new Set();
      this._disconnectListeners = new Set();
      this._connect();
    }

    _connect() {
      if (typeof window.io !== "function") {
        throw new Error("Socket.IO client not loaded");
      }
      this.socket = window.io(this.baseUrl || undefined, {
        transports: ["websocket", "polling"]
      });
      this.connected = !!this.socket.connected;
      this.socket.on("connect", () => {
        this.connected = true;
        this._connectListeners.forEach((cb) => cb());
      });
      this.socket.on("disconnect", () => {
        this.connected = false;
        this._disconnectListeners.forEach((cb) => cb());
      });
    }

    on(eventName, callback) {
      this.socket.on(eventName, callback);
      return () => this.socket.off(eventName, callback);
    }

    onConnect(callback) {
      this._connectListeners.add(callback);
      return () => this._connectListeners.delete(callback);
    }

    onDisconnect(callback) {
      this._disconnectListeners.add(callback);
      return () => this._disconnectListeners.delete(callback);
    }

    request(eventName, payload) {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fn(value);
        };
        const send = () => {
          try {
            this.socket.emit(eventName, payload || {}, (response) => {
              finish(resolve, response || {});
            });
          } catch (error) {
            finish(reject, error);
          }
        };
        const timer = setTimeout(() => {
          finish(reject, new Error(`Socket RPC timeout: ${eventName}`));
        }, RPC_TIMEOUT_MS);
        if (this.socket.connected) {
          send();
          return;
        }
        this.socket.once("connect", send);
      });
    }
  }

  class DataSnapshot {
    constructor(value, key) {
      this._value = value;
      this.key = key ?? null;
    }

    val() {
      return deepClone(this._value);
    }

    exists() {
      return this._value !== null && this._value !== undefined;
    }
  }

  class AuthLite {
    constructor(bridge) {
      this.bridge = bridge;
      this._cachedUser = null;
    }

    async signInAnonymously() {
      if (this._cachedUser?.uid) {
        return { user: deepClone(this._cachedUser) };
      }
      const existingUid = localStorage.getItem("cord_uid");
      const response = await this.bridge.request("auth:anonymous", { uid: existingUid || undefined });
      if (!response?.ok || !response.uid) {
        throw new Error(response?.error || "Anonymous auth failed");
      }
      const user = { uid: String(response.uid) };
      localStorage.setItem("cord_uid", user.uid);
      this._cachedUser = user;
      return { user: deepClone(user) };
    }
  }

  class QueryRef {
    constructor(database, path, query = {}) {
      this._database = database;
      this._path = normalizePath(path);
      this._query = { ...query };
    }

    child(segment) {
      return new QueryRef(this._database, normalizePath(`${this._path}/${segment}`), this._query);
    }

    orderByKey() {
      return new QueryRef(this._database, this._path, { ...this._query, orderByKey: true });
    }

    limitToLast(amount) {
      const safeAmount = Number(amount);
      return new QueryRef(this._database, this._path, {
        ...this._query,
        limitToLast: Number.isFinite(safeAmount) && safeAmount > 0 ? Math.floor(safeAmount) : undefined
      });
    }

    async once(eventName) {
      if (eventName !== "value") {
        throw new Error(`Unsupported once event: ${eventName}`);
      }
      const value = await this._database._readValue(this._path, this._query);
      return new DataSnapshot(value, getLastSegment(this._path));
    }

    on(eventName, callback) {
      return this._database._addListener(this._path, this._query, eventName, callback);
    }

    off(eventName, callback) {
      this._database._removeListener(this._path, this._query, eventName, callback);
    }

    set(value) {
      return this._database._setValue(this._path, value);
    }

    update(value) {
      if (this._path === "") return this._database._updateRoot(value);
      return this._database._updateValue(this._path, value);
    }

    remove() {
      return this._database._removeValue(this._path);
    }

    push(value) {
      const key = this._database._generatePushKey();
      const childRef = new QueryRef(this._database, normalizePath(`${this._path}/${key}`));
      if (arguments.length > 0) {
        return childRef.set(value).then(() => childRef);
      }
      return childRef;
    }

    onDisconnect() {
      return {
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      };
    }

    get key() {
      return getLastSegment(this._path);
    }
  }

  class DatabaseLite {
    constructor(bridge) {
      this.bridge = bridge;
      this._listeners = new Map();
      this._nextListenerId = 1;
      this._lastPushTime = 0;
      this._pushIncrement = 0;

      this.bridge.on("db:changed", (payload) => {
        const changedPath = normalizePath(payload?.path || "");
        this._onServerChange(changedPath);
      });
      this.bridge.onConnect(() => {
        this._onServerChange("");
        this._onServerChange(".info/connected");
      });
      this.bridge.onDisconnect(() => {
        this._onServerChange(".info/connected");
      });
    }

    ref(path = "") {
      return new QueryRef(this, path);
    }

    _makeSnapshot(path, value, keyOverride) {
      return new DataSnapshot(value, keyOverride ?? getLastSegment(path));
    }

    _applyQuery(value, query) {
      if (!query || (!query.orderByKey && !query.limitToLast)) return value;
      if (value == null || typeof value !== "object" || Array.isArray(value)) return value;

      let entries = sortedObjectEntries(value);
      if (query.limitToLast) entries = entries.slice(-query.limitToLast);
      const next = {};
      entries.forEach(([k, v]) => {
        next[k] = v;
      });
      return next;
    }

    async _readValue(path, query) {
      const normalizedPath = normalizePath(path);
      if (normalizedPath === ".info/connected") {
        return !!this.bridge.connected;
      }
      const response = await this.bridge.request("db:get", { path: normalizedPath });
      if (!response?.ok) {
        throw new Error(response?.error || "db:get failed");
      }
      return this._applyQuery(response.value, query);
    }

    async _setValue(path, value) {
      const response = await this.bridge.request("db:set", {
        path: normalizePath(path),
        value
      });
      if (!response?.ok) throw new Error(response?.error || "db:set failed");
    }

    async _updateValue(path, value) {
      const response = await this.bridge.request("db:update", {
        path: normalizePath(path),
        value
      });
      if (!response?.ok) throw new Error(response?.error || "db:update failed");
    }

    async _updateRoot(updates) {
      const response = await this.bridge.request("db:updateRoot", { updates: updates || {} });
      if (!response?.ok) throw new Error(response?.error || "db:updateRoot failed");
    }

    async _removeValue(path) {
      const response = await this.bridge.request("db:remove", { path: normalizePath(path) });
      if (!response?.ok) throw new Error(response?.error || "db:remove failed");
    }

    _generatePushKey() {
      const now = Date.now();
      if (now === this._lastPushTime) {
        this._pushIncrement += 1;
      } else {
        this._lastPushTime = now;
        this._pushIncrement = 0;
      }
      const t = now.toString(36).padStart(10, "0");
      const i = this._pushIncrement.toString(36).padStart(3, "0");
      const r = Math.random().toString(36).slice(2, 8);
      return `-${t}${i}${r}`;
    }

    _onServerChange(changedPath) {
      for (const listener of this._listeners.values()) {
        if (!pathsOverlap(listener.path, changedPath)) continue;
        this._pollListener(listener).catch(() => {});
      }
    }

    _addListener(path, query, eventName, callback) {
      const id = this._nextListenerId++;
      const listener = {
        id,
        path: normalizePath(path),
        query: { ...(query || {}) },
        eventName,
        callback,
        initialized: false,
        lastValue: undefined,
        lastChildren: {}
      };
      this._listeners.set(id, listener);
      this._pollListener(listener).catch(() => {});
      return callback;
    }

    _removeListener(path, query, eventName, callback) {
      const normalizedPath = normalizePath(path);
      const queryHash = JSON.stringify(query || {});
      for (const [id, listener] of this._listeners.entries()) {
        if (listener.path !== normalizedPath) continue;
        if (JSON.stringify(listener.query || {}) !== queryHash) continue;
        if (eventName && listener.eventName !== eventName) continue;
        if (callback && listener.callback !== callback) continue;
        this._listeners.delete(id);
      }
    }

    async _pollListener(listener) {
      const value = await this._readValue(listener.path, listener.query);
      if (listener.eventName === "value") {
        if (!listener.initialized || !deepEqual(listener.lastValue, value)) {
          listener.lastValue = deepClone(value);
          listener.initialized = true;
          listener.callback(this._makeSnapshot(listener.path, value));
        }
        return;
      }

      const currentChildren = {};
      if (value && typeof value === "object" && !Array.isArray(value)) {
        sortedObjectEntries(value).forEach(([k, v]) => {
          currentChildren[k] = deepClone(v);
        });
      }
      const previous = listener.lastChildren || {};

      if (listener.eventName === "child_added") {
        for (const key of Object.keys(currentChildren)) {
          if (!listener.initialized || !Object.prototype.hasOwnProperty.call(previous, key)) {
            listener.callback(this._makeSnapshot(`${listener.path}/${key}`, currentChildren[key], key));
          }
        }
      } else if (listener.eventName === "child_changed") {
        for (const key of Object.keys(currentChildren)) {
          if (Object.prototype.hasOwnProperty.call(previous, key) && !deepEqual(previous[key], currentChildren[key])) {
            listener.callback(this._makeSnapshot(`${listener.path}/${key}`, currentChildren[key], key));
          }
        }
      } else if (listener.eventName === "child_removed") {
        for (const key of Object.keys(previous)) {
          if (!Object.prototype.hasOwnProperty.call(currentChildren, key)) {
            listener.callback(this._makeSnapshot(`${listener.path}/${key}`, null, key));
          }
        }
      }

      listener.initialized = true;
      listener.lastChildren = currentChildren;
    }
  }

  const baseUrl = window.CORD_API_BASE || "https://e.vapp.uk";
  const bridge = new SocketBridge(baseUrl);
  const authInstance = new AuthLite(bridge);
  const dbInstance = new DatabaseLite(bridge);

  const firebaseCompat = {
    initializeApp: () => ({ name: "cord-local" }),
    auth: () => authInstance,
    database: () => dbInstance
  };
  firebaseCompat.database.ServerValue = { TIMESTAMP: SERVER_VALUE_TIMESTAMP };

  window.firebase = firebaseCompat;
})();
