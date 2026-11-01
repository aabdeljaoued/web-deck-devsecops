#!/bin/sh
# Lance le deck (macOS / Linux).
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install --omit=dev
exec node server/index.mjs "$@"
