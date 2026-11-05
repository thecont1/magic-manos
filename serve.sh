#!/bin/sh
# Serve the repo locally. The app is built as ES modules, so it needs a
# static server — run `npm run build` first, or use `npm start` which does
# both.
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "magic-manos on http://localhost:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
