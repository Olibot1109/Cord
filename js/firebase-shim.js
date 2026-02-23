(function () {
  const SUPABASE_URL = window.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
  const REQUEST_TIMEOUT_MS = Number(window.CORD_SUPABASE_QUEUE_TIMEOUT_MS || 15000);
  const CHANNEL = window.CORD_SUPABASE_CHANNEL || 'cord-rt-bridge';
  const LOCAL_UID_KEY = 'cord_local_uid';

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

  function completePending(payload) {
    const requestId = String(payload.request_id || '');
    if (!requestId) return;
    const item = pending.get(requestId);
    if (!item) return;

    clearTimeout(item.timer);
    pending.delete(requestId);

    if (payload.status === 'ok') item.resolve(payload.response || {});
    else item.reject(new Error(payload.error || 'Realtime request failed'));
  }

  function triggerListeners(changePath) {
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
      const channel = supabaseClient
        .channel(CHANNEL, { config: { broadcast: { self: true } } })
        .on('broadcast', { event: 'response' }, ({ payload }) => {
          if (!payload) return;
          if (payload.client_id && payload.client_id !== clientId) return;
          completePending(payload);
        })
        .on('broadcast', { event: 'change' }, ({ payload }) => {
          if (!payload) return;
          triggerListeners(String(payload.path || ''));
        });

      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channelReady = true;
          resolve();
        }
        if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') {
          reject(new Error(`Supabase realtime channel failed: ${status}`));
        }
      });

      window.__cordRealtimeChannel = channel;
    });

    return channelReadyPromise;
  }

  async function requestViaRealtime(op, path, payload) {
    await ensureRealtimeChannel();

    const requestId = makeKey();
    const requestPayload = {
      request_id: requestId,
      client_id: clientId,
      op,
      path: normalizePath(path),
      payload: payload || {},
      ts_ms: Date.now(),
    };

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Realtime request timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
    });

    const channel = window.__cordRealtimeChannel;
    const sendStatus = await channel.send({
      type: 'broadcast',
      event: 'request',
      payload: requestPayload,
    });

    if (sendStatus !== 'ok') {
      const item = pending.get(requestId);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(requestId);
      }
      throw new Error(`Realtime send failed: ${sendStatus}`);
    }

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
            console.error('[supabase-realtime-bridge] listener error', err);
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

    push(value) {
      const key = makeKey();
      const childRef = this.child(key);
      const promise = childRef.set(value).then(() => ({ key }));
      childRef.key = key;
      childRef.then = promise.then.bind(promise);
      childRef.catch = promise.catch.bind(promise);
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
    console.error('[supabase-realtime-bridge] failed to subscribe', err);
  });
})();
