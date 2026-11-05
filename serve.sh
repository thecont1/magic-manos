#!/bin/sh
# Serve the app locally. index.html is a single self-contained file — any
# static server works; this just saves you typing it.
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "magic-manos on http://localhost:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
