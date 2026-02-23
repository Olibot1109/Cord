import asyncio
import json
import os
import sqlite3
import sys
import time
import uuid
from contextlib import contextmanager
from typing import Any
from urllib.parse import quote_plus

import websockets
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

DB_FILE = os.environ.get('CORD_LOCAL_DB', os.path.join(os.path.dirname(__file__), 'cord_local.db'))
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_REALTIME_KEY = (
    os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    or os.environ.get('SUPABASE_ANON_KEY', '')
)
SUPABASE_CHANNEL = os.environ.get('CORD_SUPABASE_CHANNEL', 'cord-rt-bridge')
LOG_LEVEL_NAME = str(os.environ.get('CORD_LOG_LEVEL', 'info') or 'info').strip().lower()
_ws_max_size_raw = os.environ.get('CORD_WS_MAX_SIZE')
if _ws_max_size_raw is None:
    WS_MAX_SIZE: int | None = 16 * 1024 * 1024
else:
    try:
        parsed_size = int(str(_ws_max_size_raw).strip())
        WS_MAX_SIZE = parsed_size if parsed_size > 0 else None
    except Exception:
        WS_MAX_SIZE = 16 * 1024 * 1024
try:
    SLOW_REQUEST_MS = int(os.environ.get('CORD_SLOW_REQUEST_MS', '350') or '350')
except Exception:
    SLOW_REQUEST_MS = 350

ANSI_RESET = '\033[0m'
ANSI_BOLD = '\033[1m'
ANSI_RED = '\033[31m'
ANSI_GREEN = '\033[32m'
ANSI_YELLOW = '\033[33m'
ANSI_BLUE = '\033[34m'
ANSI_CYAN = '\033[36m'
ANSI_GRAY = '\033[90m'
ANSI_MAGENTA = '\033[35m'

LOG_LEVELS = {
    'debug': 10,
    'info': 20,
    'warn': 30,
    'error': 40,
}

LEVEL_COLORS = {
    'debug': ANSI_GRAY,
    'info': ANSI_BLUE,
    'warn': ANSI_YELLOW,
    'error': ANSI_RED,
}

OP_COLORS = {
    'auth.anonymous': ANSI_BLUE,
    'read': ANSI_CYAN,
    'set': ANSI_YELLOW,
    'update': ANSI_YELLOW,
    'remove': ANSI_RED,
}


def supports_color() -> bool:
    if os.environ.get('NO_COLOR'):
        return False
    if os.environ.get('TERM') == 'dumb':
        return False
    return sys.stdout.isatty()


COLOR_ENABLED = supports_color()
CURRENT_LOG_LEVEL = LOG_LEVELS.get(LOG_LEVEL_NAME, LOG_LEVELS['info'])


def colorize(text: str, color: str, *, bold: bool = False) -> str:
    if not COLOR_ENABLED:
        return text
    style = f'{ANSI_BOLD}{color}' if bold else color
    return f'{style}{text}{ANSI_RESET}'


def timestamp_hms() -> str:
    now = time.time()
    ms = int((now * 1000) % 1000)
    return f'{time.strftime("%H:%M:%S", time.localtime(now))}.{ms:03d}'


def console_log(label: str, message: str, color: str = ANSI_GRAY) -> None:
    prefix = colorize(f'[{timestamp_hms()}] {label:<8}', color, bold=True)
    print(f'{prefix} {message}', flush=True)


def should_log(level: str) -> bool:
    return LOG_LEVELS.get(level, LOG_LEVELS['info']) >= CURRENT_LOG_LEVEL


def log_event(level: str, label: str, message: str, color: str | None = None) -> None:
    if not should_log(level):
        return
    console_log(label, message, color or LEVEL_COLORS.get(level, ANSI_GRAY))


def display_path(path: str) -> str:
    normalized = normalize_path(path)
    return f'/{normalized}' if normalized else '/'


def summarize_json(value: Any, max_len: int = 240) -> str:
    try:
        payload = json.dumps(value, separators=(',', ':'), sort_keys=True)
    except Exception:
        payload = repr(value)
    if len(payload) <= max_len:
        return payload
    return payload[: max_len - 3] + '...'


def op_log_level(op: str) -> str:
    # Read traffic is high volume; keep it in debug by default.
    return 'debug' if op == 'read' else 'info'


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_FILE)
    try:
        conn.row_factory = sqlite3.Row
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              data TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS request_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts_ms INTEGER NOT NULL,
              direction TEXT NOT NULL,
              op TEXT NOT NULL,
              path TEXT NOT NULL,
              payload TEXT
            )
            '''
        )
        row = conn.execute('SELECT data FROM state WHERE id = 1').fetchone()
        if not row:
            conn.execute('INSERT INTO state (id, data) VALUES (1, ?)', (json.dumps({}),))


def normalize_path(path: str) -> str:
    if not path:
        return ''
    return path.strip('/')


def load_root(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute('SELECT data FROM state WHERE id = 1').fetchone()
    if not row:
        return {}
    try:
        return json.loads(row['data'])
    except Exception:
        return {}


def save_root(conn: sqlite3.Connection, root: dict[str, Any]) -> None:
    conn.execute('UPDATE state SET data = ? WHERE id = 1', (json.dumps(root, separators=(',', ':')),))


def split_path(path: str) -> list[str]:
    p = normalize_path(path)
    return [part for part in p.split('/') if part] if p else []


def get_value(root: dict[str, Any], path: str) -> Any:
    node: Any = root
    for part in split_path(path):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def ensure_parent(root: dict[str, Any], path: str) -> tuple[dict[str, Any], str | None]:
    parts = split_path(path)
    if not parts:
        return root, None
    node: Any = root
    for part in parts[:-1]:
        if not isinstance(node, dict):
            raise ValueError('Path parent is not an object')
        if part not in node or not isinstance(node[part], dict):
            node[part] = {}
        node = node[part]
    return node, parts[-1]


def set_value(root: dict[str, Any], path: str, value: Any) -> None:
    if normalize_path(path) == '':
        if not isinstance(value, dict):
            raise ValueError('Root value must be an object')
        root.clear()
        root.update(value)
        return
    parent, key = ensure_parent(root, path)
    if key is None:
        return
    parent[key] = value


def update_value(root: dict[str, Any], path: str, value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError('Update value must be an object')
    base_path = normalize_path(path)
    for k, v in value.items():
        key_path = normalize_path(str(k))
        target_path = '/'.join(part for part in [base_path, key_path] if part)
        if v is None:
            remove_value(root, target_path)
        else:
            set_value(root, target_path, v)


def remove_value(root: dict[str, Any], path: str) -> None:
    parts = split_path(path)
    if not parts:
        root.clear()
        return
    node: Any = root
    for part in parts[:-1]:
        if not isinstance(node, dict) or part not in node:
            return
        node = node[part]
    if isinstance(node, dict):
        node.pop(parts[-1], None)


def apply_query(value: Any, query: dict[str, Any]) -> Any:
    if not isinstance(value, dict):
        return value

    items = list(value.items())
    if query.get('orderBy') == 'key':
        items.sort(key=lambda kv: kv[0])

    if query.get('startAt') is not None:
        start_at = str(query.get('startAt'))
        items = [kv for kv in items if kv[0] >= start_at]

    if query.get('endAt') is not None:
        end_at = str(query.get('endAt'))
        items = [kv for kv in items if kv[0] <= end_at]

    if query.get('equalTo') is not None:
        equal_to = str(query.get('equalTo'))
        items = [kv for kv in items if kv[0] == equal_to]

    limit = query.get('limitToLast')
    try:
        limit_int = int(limit) if limit is not None else None
    except Exception:
        limit_int = None

    if limit_int and limit_int > 0:
        items = items[-limit_int:]

    return {k: v for k, v in items}


def log_request(conn: sqlite3.Connection, direction: str, op: str, path: str, payload: Any) -> None:
    conn.execute(
        'INSERT INTO request_log (ts_ms, direction, op, path, payload) VALUES (?, ?, ?, ?, ?)',
        (int(time.time() * 1000), direction, op, normalize_path(path), json.dumps(payload, separators=(',', ':'))),
    )


def process_single_request(op: str, path: str, payload: dict[str, Any]) -> Any:
    normalized_op = str(op or '').strip().lower()

    with get_conn() as conn:
        root = load_root(conn)
        log_request(conn, 'realtime-inbound', normalized_op, path, payload)

        if normalized_op == 'auth.anonymous':
            return {'uid': f'u_{uuid.uuid4().hex[:20]}'}

        if normalized_op == 'read':
            query = payload.get('query') or {}
            raw = get_value(root, path)
            value = apply_query(raw, query)
            return {'path': normalize_path(path), 'value': value}

        if normalized_op == 'set':
            value = payload.get('value')
            if isinstance(value, dict) and value.get('.sv') == 'timestamp':
                value = int(time.time() * 1000)
            set_value(root, path, value)
            save_root(conn, root)
            return {'ok': True}

        if normalized_op == 'update':
            update_value(root, path, payload.get('value'))
            save_root(conn, root)
            return {'ok': True}

        if normalized_op == 'remove':
            remove_value(root, path)
            save_root(conn, root)
            return {'ok': True}

    raise ValueError(f'Unsupported op: {op}')


class SupabaseRealtimeBridge:
    def __init__(self, url: str, apikey: str, channel: str) -> None:
        self.url = url
        self.apikey = apikey
        self.channel = channel
        self.topic = f'realtime:{channel}'
        self._ref = 1
        self._send_lock: asyncio.Lock | None = None
        self.ws = None
        self._join_logged = False

    @property
    def ws_url(self) -> str:
        base = self.url
        if base.startswith('https://'):
            base = 'wss://' + base[len('https://'):]
        elif base.startswith('http://'):
            base = 'ws://' + base[len('http://'):]
        key = quote_plus(self.apikey)
        return f'{base}/realtime/v1/websocket?apikey={key}&vsn=1.0.0'

    def next_ref(self) -> str:
        ref = str(self._ref)
        self._ref += 1
        return ref

    async def send_json(self, message: dict[str, Any]) -> None:
        if not self.ws:
            return
        if self._send_lock is None:
            self._send_lock = asyncio.Lock()
        async with self._send_lock:
            event = str(message.get('event') or '')
            topic = str(message.get('topic') or '')
            payload = message.get('payload') or {}
            if event == 'broadcast' and should_log('debug'):
                b_event = str(payload.get('event') or '')
                b_payload = payload.get('payload') or {}
                request_id = str(b_payload.get('request_id') or '-')
                log_event(
                    'debug',
                    'ws-out',
                    (
                        f'topic={topic} event={event}/{b_event} '
                        f'req={request_id} payload={summarize_json(b_payload, max_len=160)}'
                    ),
                    ANSI_MAGENTA,
                )
            elif event != 'heartbeat' and should_log('debug'):
                log_event('debug', 'ws-out', f'topic={topic} event={event}', ANSI_MAGENTA)
            await self.ws.send(json.dumps(message, separators=(',', ':')))

    async def join_channel(self) -> None:
        await self.send_json({
            'topic': self.topic,
            'event': 'phx_join',
            'payload': {
                'config': {
                    'broadcast': {'ack': False, 'self': True},
                    'presence': {'key': ''},
                    'private': False,
                }
            },
            'ref': self.next_ref(),
        })

    async def send_broadcast(self, event_name: str, payload: dict[str, Any]) -> None:
        await self.send_json({
            'topic': self.topic,
            'event': 'broadcast',
            'payload': {
                'type': 'broadcast',
                'event': event_name,
                'payload': payload,
            },
            'ref': self.next_ref(),
        })

    async def heartbeat_loop(self) -> None:
        while self.ws is not None:
            await asyncio.sleep(20)
            try:
                await self.send_json({
                    'topic': 'phoenix',
                    'event': 'heartbeat',
                    'payload': {},
                    'ref': self.next_ref(),
                })
                log_event('debug', 'heartbeat', f'topic={self.topic}', ANSI_GRAY)
            except Exception:
                log_event('warn', 'heartbeat', 'failed to send heartbeat', ANSI_YELLOW)
                return

    async def handle_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('request_id') or '')
        if not request_id:
            return

        client_id = str(payload.get('client_id') or '')
        op = str(payload.get('op') or '').strip().lower()
        path = str(payload.get('path') or '')
        body = payload.get('payload') or {}
        started = time.perf_counter()
        req_level = op_log_level(op)

        op_color = OP_COLORS.get(op, ANSI_BLUE)
        if should_log(req_level):
            log_event(
                req_level,
                'request',
                (
                    f'id={request_id} client={client_id or "-"} op={colorize(op or "unknown", op_color)} '
                    f'path={display_path(path)} payload={summarize_json(body)}'
                ),
                ANSI_CYAN,
            )

        try:
            result = await asyncio.to_thread(process_single_request, op, path, body)
            response = {
                'request_id': request_id,
                'client_id': client_id,
                'status': 'ok',
                'response': result,
                'error': None,
                'ts_ms': int(time.time() * 1000),
            }
            await self.send_broadcast('response', response)

            duration_ms = (time.perf_counter() - started) * 1000
            result_level = 'warn' if duration_ms >= SLOW_REQUEST_MS else req_level
            if should_log(result_level):
                log_event(
                    result_level,
                    'ok',
                    f'id={request_id} op={op or "unknown"} {duration_ms:.1f}ms result={summarize_json(result)}',
                    ANSI_GREEN if result_level != 'warn' else ANSI_YELLOW,
                )

            if op in {'set', 'update', 'remove'}:
                await self.send_broadcast('change', {
                    'path': normalize_path(path),
                    'op': op,
                    'ts_ms': int(time.time() * 1000),
                })
                log_event('debug', 'change', f'op={op} path={display_path(path)}', ANSI_MAGENTA)
        except Exception as exc:
            await self.send_broadcast('response', {
                'request_id': request_id,
                'client_id': client_id,
                'status': 'error',
                'response': None,
                'error': str(exc),
                'ts_ms': int(time.time() * 1000),
            })
            duration_ms = (time.perf_counter() - started) * 1000
            console_log(
                'error',
                f'id={request_id} op={op or "unknown"} {duration_ms:.1f}ms error={exc}',
                ANSI_RED,
            )

    async def handle_message(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except Exception as exc:
            log_event('warn', 'ws-in', f'invalid json: {exc}', ANSI_YELLOW)
            return

        event = message.get('event')
        topic = str(message.get('topic') or '')
        if event != 'heartbeat' and should_log('debug'):
            log_event('debug', 'ws-in', f'topic={topic} event={event}', ANSI_MAGENTA)
        if event == 'phx_reply':
            if str(message.get('topic') or '') == self.topic and not self._join_logged:
                self._join_logged = True
                console_log('connected', f'joined channel={self.channel}', ANSI_GREEN)
            return

        if event == 'phx_close' or event == 'phx_error':
            console_log('warning', f'socket event={event}', ANSI_YELLOW)
            return

        if event != 'broadcast':
            return

        payload = message.get('payload') or {}
        broadcast_event = payload.get('event')
        broadcast_payload = payload.get('payload') or {}
        if broadcast_event != 'request' and should_log('debug'):
            log_event('debug', 'broadcast', f'event={broadcast_event}', ANSI_GRAY)

        if broadcast_event == 'request':
            await self.handle_request(broadcast_payload)

    async def run_once(self) -> None:
        self._send_lock = asyncio.Lock()
        async with websockets.connect(
            self.ws_url,
            ping_interval=None,
            ping_timeout=None,
            max_size=WS_MAX_SIZE,
        ) as websocket:
            self.ws = websocket
            self._join_logged = False
            console_log('connect', f'connecting channel={self.channel}', ANSI_BLUE)
            await self.join_channel()
            hb_task = asyncio.create_task(self.heartbeat_loop())
            try:
                async for raw in websocket:
                    await self.handle_message(raw)
            finally:
                hb_task.cancel()
                self.ws = None
                console_log('disconnect', f'channel={self.channel}', ANSI_YELLOW)

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as exc:
                console_log('retry', f'connection dropped ({exc}), retrying in 1s', ANSI_YELLOW)
                await asyncio.sleep(1)


def run_realtime_worker() -> None:
    if not SUPABASE_URL or not SUPABASE_REALTIME_KEY:
        console_log(
            'error',
            'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY',
            ANSI_RED,
        )
        return

    bridge = SupabaseRealtimeBridge(SUPABASE_URL, SUPABASE_REALTIME_KEY, SUPABASE_CHANNEL)
    ws_max_size_display = 'unlimited' if WS_MAX_SIZE is None else str(WS_MAX_SIZE)
    console_log(
        'start',
        (
            f'db={DB_FILE} channel={SUPABASE_CHANNEL} log_level={LOG_LEVEL_NAME} '
            f'color={COLOR_ENABLED} ws_max_size={ws_max_size_display}'
        ),
        ANSI_BLUE,
    )
    asyncio.run(bridge.run_forever())


if __name__ == '__main__':
    init_db()
    run_realtime_worker()
