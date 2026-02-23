#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

VENV_DIR=".venv_local"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi

VENV_PY="$(pwd)/$VENV_DIR/bin/python"
"$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
"$VENV_PY" -m pip install --upgrade pip >/dev/null
"$VENV_PY" -m pip install -r requirements.txt >/dev/null

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

exec "$VENV_PY" app.py
