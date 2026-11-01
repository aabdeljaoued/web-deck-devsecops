#!/bin/sh
# Lanceur macOS : double-clic dans le Finder (ouvre une fenêtre Terminal ; la fermer arrête le deck).
exec "$(dirname "$0")/start.sh" "$@"
