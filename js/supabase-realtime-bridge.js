(function () {
  const SUPABASE_URL = window.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
  const REQUEST_TIMEOUT_MS = Number(window.CORD_SUPABASE_QUEUE_TIMEOUT_MS || 15000);
  const CHANNEL = window.CORD_SUPABASE_CHANNEL || 'cord-rt-bridge';
  const LOCAL_UID_KEY = 'cord_local_uid';
  const RT_LOG_LEVEL = String(window.CORD_RT_LOG_LEVEL || 'info').toLowerCase();
  const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const LOG_COLORS = {
    debug: '#64748b',
    info: '#0ea5e9',
    warn: '#f59e0b',
    error: '#ef4444'
  };

  function stringifyLogArg(arg) {
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'undefined') return 'undefined';
    if (typeof arg === 'function') return `[Function ${arg.name || 'anonymous'}]`;
    try {
      return JSON.stringify(arg);
    } catch (err) {
      return String(arg);
    }
  }

  function formatConsoleArgs(args) {
    if (!args || !args.length) return '';
    const values = Array.from(args);
    if (typeof values[0] !== 'string') {
      return values.map(stringifyLogArg).join(' ').trim();
    }

    const fmt = values[0];
    let index = 1;
    const text = fmt.replace(/%[sdifoOc]/g, (token) => {
      if (index >= values.length) return token;
      const value = values[index++];
      if (token === '%c') return '';
      if (token === '%d' || token === '%i' || token === '%f') return String(Number(value));
      return stringifyLogArg(value);
    }).replace(/\s+/g, ' ').trim();

    const tail = values.slice(index).map(stringifyLogArg).join(' ').trim();
    return `${text}${tail ? ` ${tail}` : ''}`.trim();
  }

  function installClientLogCapture() {
    if (window.__cordClientLogApi) return;

    const limitRaw = Number(window.CORD_CLIENT_LOG_LIMIT || 500);
    const maxEntries = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 500;
    const entries = Array.isArray(window.__cordClientLogs) ? window.__cordClientLogs : [];
    let seq = Number(window.__cordClientLogSeq || entries.length || 0);
    const listeners = new Set();

    function emit(entry) {
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch (err) {
          // Never let log subscribers break logging.
        }
      }
    }

    function pushEntry(level, args) {
      const message = formatConsoleArgs(args);
      if (!message) return;
      seq += 1;
      window.__cordClientLogSeq = seq;
      const entry = {
        id: seq,
        ts: Date.now(),
        level,
        message
      };
      entries.push(entry);
      if (entries.length > maxEntries) {
        entries.splice(0, entries.length - maxEntries);
      }
      emit(entry);
    }

    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const original = {};
    const baseLog = typeof console.log === 'function' ? console.log.bind(console) : function () {};
    methods.forEach((method) => {
      const nativeMethod = typeof console[method] === 'function' ? console[method].bind(console) : baseLog;
      original[method] = nativeMethod;
      console[method] = function (...args) {
        try {
          pushEntry(method, args);
        } catch (err) {
          // Keep native console behavior even if capture fails.
        }
        return nativeMethod(...args);
      };
    });

    window.__cordClientLogs = entries;
    window.__cordClientLogApi = {
      maxEntries,
      getEntries: () => entries.slice(),
      clear: () => {
        entries.length = 0;
        emit(null);
      },
      subscribe: (listener) => {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      originalConsole: original
    };
  }

  installClientLogCapture();

  function shouldLog(level) {
    const target = LOG_LEVELS[level] || LOG_LEVELS.info;
    const current = LOG_LEVELS[RT_LOG_LEVEL] || LOG_LEVELS.info;
    return target >= current;
  }

  function levelMethod(level) {
    if (level === 'error') return console.error;
    if (level === 'warn') return console.warn;
    return console.log;
  }

  function summarize(value, maxLen) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      text = String(value);
    }
    const limit = Number(maxLen) > 0 ? Number(maxLen) : 180;
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 3)}...`;
  }

  function rtLog(level, label, message, meta) {
    if (!shouldLog(level)) return;
    const color = LOG_COLORS[level] || LOG_COLORS.debug;
    const prefix = `%c[rt:${level}] ${label}`;
    const style = `color:${color};font-weight:600`;
    const logger = levelMethod(level).bind(console);
    if (meta === undefined) logger(prefix, style, message);
    else logger(prefix, style, message, meta);
  }

  function normalizePath(path) {
    if (!path) return '';
    return String(path).replace(/^\/+|\/+$/g, '');
  }

  const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let lastPushTime = 0;
  let lastPushRandChars = [];

  function makeKey() {
    let now = Date.now();
    const duplicateTime = now === lastPushTime;
    lastPushTime = now;

    const timeChars = new Array(8);
    for (let i = 7; i >= 0; i -= 1) {
      timeChars[i] = PUSH_CHARS.charAt(now % 64);
      now = Math.floor(now / 64);
    }

    if (!duplicateTime) {
      lastPushRandChars = [];
      for (let i = 0; i < 12; i += 1) {
        lastPushRandChars[i] = Math.floor(Math.random() * 64);
      }
    } else {
      for (let i = 11; i >= 0; i -= 1) {
        if (lastPushRandChars[i] === 63) {
          lastPushRandChars[i] = 0;
        } else {
          lastPushRandChars[i] += 1;
          break;
        }
      }
    }

    let id = timeChars.join('');
    for (let i = 0; i < 12; i += 1) {
      id += PUSH_CHARS.charAt(lastPushRandChars[i]);
    }
    return id;
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function pathsRelated(a, b) {
    const p1 = normalizePath(a);
    const p2 = normalizePath(b);
    if (!p1 || !p2) return true;
    return p1 === p2 || p1.startsWith(`${p2}/`) || p2.startsWith(`${p1}/`);
  }

  class Snapshot {
    constructor(key, value) {
      this.key = key || null;
      this._value = value;
    }

    val() {
      return this._value;
    }

    exists() {
      return this._value !== null && this._value !== undefined;
    }

    forEach(cb) {
      if (!this._value || typeof this._value !== 'object') return false;
      for (const [k, v] of Object.entries(this._value)) {
        const shouldStop = cb(new Snapshot(k, v));
        if (shouldStop === true) return true;
      }
      return false;
    }
  }

  function applyQuery(value, query) {
    if (!query || value == null || typeof value !== 'object' || Array.isArray(value)) return value;

    let entries = Object.entries(value);
    if (query.orderBy === 'key') entries.sort((a, b) => a[0].localeCompare(b[0]));
    if (query.startAt !== undefined && query.startAt !== null) entries = entries.filter(([k]) => k >= String(query.startAt));
    if (query.endAt !== undefined && query.endAt !== null) entries = entries.filter(([k]) => k <= String(query.endAt));
    if (query.equalTo !== undefined && query.equalTo !== null) entries = entries.filter(([k]) => k === String(query.equalTo));
    if (Number.isFinite(query.limitToLast) && query.limitToLast > 0) entries = entries.slice(-query.limitToLast);

    return Object.fromEntries(entries);
  }

  if (!window.supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase config is required. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }

  const clientId = makeKey();
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const pending = new Map();
  const listeners = new Set();
  let channelReady = false;
  let channelReadyPromise = null;

  function opLogLevel(op) {
    return op === 'read' ? 'debug' : 'info';
  }

  function rejectAllPending(reason) {
    for (const [requestId, item] of pending.entries()) {
      clearTimeout(item.timer);
      pending.delete(requestId);
      item.reject(new Error(reason));
    }
  }

  function resetChannelState(reason) {
    const channel = window.__cordRealtimeChannel;
    if (channel && typeof channel.unsubscribe === 'function') {
      try {
        channel.unsubscribe();
      } catch (err) {
        rtLog('debug', 'channel', `unsubscribe failed reason=${reason}`);
      }
    }
    window.__cordRealtimeChannel = null;
    channelReady = false;
    channelReadyPromise = null;
    rejectAllPending(`Realtime channel reset: ${reason}`);
    rtLog('warn', 'channel', `reset reason=${reason}`);
  }

  function completePending(payload) {
    const requestId = String(payload.request_id || '');
    if (!requestId) return;
    const item = pending.get(requestId);
    if (!item) return;

    clearTimeout(item.timer);
    pending.delete(requestId);

    const tookMs = Date.now() - item.startedAt;
    const level = opLogLevel(item.op);
    if (payload.status === 'ok') {
      rtLog(
        level,
        'response',
        `id=${requestId} op=${item.op} path=/${item.path || ''} ${tookMs}ms`,
        item.op === 'read' ? undefined : (payload.response || {})
      );
      item.resolve(payload.response || {});
    } else {
      rtLog(
        'warn',
        'response',
        `id=${requestId} op=${item.op} path=/${item.path || ''} ${tookMs}ms error=${payload.error || 'unknown'}`,
      );
      item.reject(new Error(payload.error || 'Realtime request failed'));
    }
  }

  function triggerListeners(changePath) {
    rtLog('debug', 'change', `path=/${normalizePath(changePath)}`);
    for (const listener of listeners) {
      if (listener.dead) continue;
      if (!pathsRelated(listener.path, changePath)) continue;
      if (listener.scheduled) continue;
      listener.scheduled = true;
      setTimeout(() => {
        listener.scheduled = false;
        listener.refresh();
      }, 0);
    }
  }

  async function ensureRealtimeChannel() {
    if (channelReady) return;
    if (channelReadyPromise) return channelReadyPromise;

    channelReadyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      rtLog('info', 'connect', `subscribing channel=${CHANNEL}`);
      const channel = supabaseClient
        .channel(CHANNEL, { config: { broadcast: { self: true } } })
        .on('broadcast', { event: 'response' }, ({ payload }) => {
          if (!payload) return;
          if (payload.client_id && payload.client_id !== clientId) return;
          completePending(payload);
        })
        .on('broadcast', { event: 'change' }, ({ payload }) => {
          if (!payload) return;
          rtLog('debug', 'ws-in', `broadcast=change payload=${summarize(payload, 160)}`);
          triggerListeners(String(payload.path || ''));
        });

      channel.subscribe((status) => {
        if (window.__cordRealtimeChannel !== channel) return;
        rtLog('info', 'channel', `status=${status}`);
        if (status === 'SUBSCRIBED') {
          channelReady = true;
          settleOk();
        }
        if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
          resetChannelState(`status_${status}`);
          settleErr(new Error(`Supabase realtime channel failed: ${status}`));
        }
      });

      window.__cordRealtimeChannel = channel;
    });

    return channelReadyPromise;
  }

  async function requestViaRealtime(op, path, payload) {
    await ensureRealtimeChannel();

    const requestId = makeKey();
    const normalizedPath = normalizePath(path);
    const requestLevel = opLogLevel(op);
    const requestPayload = {
      request_id: requestId,
      client_id: clientId,
      op,
      path: normalizedPath,
      payload: payload || {},
      ts_ms: Date.now(),
    };

    rtLog(
      requestLevel,
      'request',
      `id=${requestId} op=${op} path=/${normalizedPath} timeout=${REQUEST_TIMEOUT_MS}ms`,
      op === 'read' ? undefined : summarize(requestPayload.payload, 180)
    );

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        rtLog('warn', 'timeout', `id=${requestId} op=${op} path=/${normalizedPath}`);
        reject(new Error('Realtime request timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, {
        resolve,
        reject,
        timer,
        startedAt: Date.now(),
        op,
        path: normalizedPath
      });
    });

    const channel = window.__cordRealtimeChannel;
    if (!channel) {
      resetChannelState('missing_channel');
      throw new Error('Realtime channel unavailable');
    }
    let sendStatus;
    try {
      sendStatus = await channel.send({
        type: 'broadcast',
        event: 'request',
        payload: requestPayload,
      });
    } catch (err) {
      resetChannelState('send_exception');
      rtLog('error', 'send', `id=${requestId} op=${op} exception=${err?.message || String(err)}`);
      throw err;
    }

    if (sendStatus !== 'ok') {
      resetChannelState(`send_${sendStatus}`);
      rtLog('error', 'send', `id=${requestId} op=${op} status=${sendStatus}`);
      throw new Error(`Realtime send failed: ${sendStatus}`);
    }

    rtLog('debug', 'send', `id=${requestId} op=${op} status=${sendStatus}`);
    return promise;
  }

  class DBRef {
    constructor(db, path, query) {
      this._db = db;
      this._path = normalizePath(path);
      this._query = query || {};
      this._listeners = [];
    }

    get key() {
      if (!this._path) return null;
      const parts = this._path.split('/');
      return parts[parts.length - 1] || null;
    }

    child(segment) {
      const seg = normalizePath(segment);
      const next = [this._path, seg].filter(Boolean).join('/');
      return new DBRef(this._db, next, this._query);
    }

    orderByKey() { return new DBRef(this._db, this._path, { ...this._query, orderBy: 'key' }); }
    limitToLast(n) { return new DBRef(this._db, this._path, { ...this._query, limitToLast: Number(n) }); }
    startAt(value) { return new DBRef(this._db, this._path, { ...this._query, startAt: value }); }
    endAt(value) { return new DBRef(this._db, this._path, { ...this._query, endAt: value }); }
    equalTo(value) { return new DBRef(this._db, this._path, { ...this._query, equalTo: value }); }

    _asSnapshot(value) {
      return new Snapshot(this.key, applyQuery(value, this._query));
    }

    once(eventType, callback) {
      return requestViaRealtime('read', this._path, { query: this._query }).then((payload) => {
        const snap = this._asSnapshot(payload.value);
        if (typeof callback === 'function') callback(snap);
        return snap;
      });
    }

    on(eventType, handler) {
      if (typeof handler !== 'function') return handler;

      const listener = {
        path: this._path,
        query: { ...this._query },
        eventType,
        handler,
        dead: false,
        scheduled: false,
        prevValue: undefined,
        refresh: async () => {
          if (listener.dead) return;
          try {
            const payload = await requestViaRealtime('read', this._path, { query: this._query });
            const nextValue = applyQuery(payload.value, this._query);

            if (eventType === 'value') {
              if (listener.prevValue === undefined || !deepEqual(listener.prevValue, nextValue)) {
                handler(this._asSnapshot(nextValue));
              }
            } else if (eventType === 'child_added' || eventType === 'child_removed' || eventType === 'child_changed') {
              const prevObj = (listener.prevValue && typeof listener.prevValue === 'object') ? listener.prevValue : {};
              const nextObj = (nextValue && typeof nextValue === 'object') ? nextValue : {};
              const prevKeys = new Set(Object.keys(prevObj));
              const nextKeys = new Set(Object.keys(nextObj));

              if (eventType === 'child_added') {
                for (const k of nextKeys) if (!prevKeys.has(k)) handler(new Snapshot(k, nextObj[k]));
              }
              if (eventType === 'child_removed') {
                for (const k of prevKeys) if (!nextKeys.has(k)) handler(new Snapshot(k, prevObj[k]));
              }
              if (eventType === 'child_changed') {
                for (const k of nextKeys) if (prevKeys.has(k) && !deepEqual(prevObj[k], nextObj[k])) handler(new Snapshot(k, nextObj[k]));
              }
            }

            listener.prevValue = nextValue;
          } catch (err) {
            rtLog('error', 'listener', `event=${eventType} path=/${this._path}`, err);
          }
        }
      };

      this._listeners.push(listener);
      listeners.add(listener);
      listener.refresh();
      return handler;
    }

    off(eventType, handler) {
      this._listeners = this._listeners.filter((listener) => {
        const eventOk = !eventType || listener.eventType === eventType;
        const handlerOk = !handler || listener.handler === handler;
        const match = eventOk && handlerOk;
        if (match) {
          listener.dead = true;
          listeners.delete(listener);
        }
        return !match;
      });
    }

    set(value) { return requestViaRealtime('set', this._path, { value }).then(() => null); }
    update(value) { return requestViaRealtime('update', this._path, { value }).then(() => null); }
    remove() { return requestViaRealtime('remove', this._path, {}).then(() => null); }

    push(value, onComplete) {
      if (typeof value === 'function' && onComplete === undefined) {
        onComplete = value;
        value = undefined;
      }
      const childRef = this.child(makeKey());
      const hasValue = value !== undefined;
      let promise = hasValue
        ? childRef.set(value).then(() => ({ key: childRef.key }))
        : Promise.resolve({ key: childRef.key });

      if (typeof onComplete === 'function') {
        promise = promise.then((result) => {
          onComplete(null);
          return result;
        }, (err) => {
          onComplete(err);
          throw err;
        });
      }

      childRef.then = promise.then.bind(promise);
      childRef.catch = promise.catch.bind(promise);
      childRef.finally = promise.finally.bind(promise);
      return childRef;
    }

    transaction(updater) {
      return requestViaRealtime('read', this._path, { query: this._query }).then((payload) => {
        const current = payload.value;
        const next = updater(current);
        return this.set(next).then(() => ({ committed: true, snapshot: this._asSnapshot(next) }));
      });
    }

    onDisconnect() {
      return { set: () => Promise.resolve(), remove: () => Promise.resolve() };
    }
  }

  class FirebaseDatabase {
    ref(path) { return new DBRef(this, path, {}); }
  }

  class FirebaseAuth {
    signInAnonymously() {
      const existing = localStorage.getItem(LOCAL_UID_KEY);
      if (existing) return Promise.resolve({ user: { uid: existing } });
      const uid = `u_${makeKey().replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
      localStorage.setItem(LOCAL_UID_KEY, uid);
      return Promise.resolve({ user: { uid } });
    }
  }

  let dbInstance = null;
  let authInstance = null;

  window.firebase = {
    initializeApp: function () { return {}; },
    database: function () {
      if (!dbInstance) dbInstance = new FirebaseDatabase();
      return dbInstance;
    },
    auth: function () {
      if (!authInstance) authInstance = new FirebaseAuth();
      return authInstance;
    }
  };

  window.firebase.database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };

  ensureRealtimeChannel().catch((err) => {
    rtLog('error', 'connect', 'failed to subscribe realtime channel', err);
  });
})();
