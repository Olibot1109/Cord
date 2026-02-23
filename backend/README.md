# Cord Python Backend (Supabase Realtime Broadcast + SQLite)

This backend connects to Supabase Realtime over WebSockets and fulfills requests against local SQLite.

## Flow

1. Frontend sends a Realtime broadcast event `request` on channel `cord-rt-bridge`
2. Python backend (subscribed to same channel) processes request on SQLite
3. Python sends Realtime broadcast event `response`
4. For writes (`set/update/remove`), Python also broadcasts `change`

No DB polling queue is used in this mode.

## Run

```bash
cd /Users/olie/Desktop/Projects/Cord/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

`app.py` now runs as a realtime worker only (no Flask/HTTP server).

## Env (`backend/.env`)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`)
- `CORD_SUPABASE_CHANNEL` (default `cord-rt-bridge`)
