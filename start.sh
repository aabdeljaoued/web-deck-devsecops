#!/bin/sh
# Lance le deck (macOS / Linux) : Node.js portable dans ./node/ s'il existe, sinon celui du PATH.
cd "$(dirname "$0")" || exit 1

# Lancé depuis le Finder (start.command) : le PATH ne contient pas toujours Homebrew
for dir in /opt/homebrew/bin /usr/local/bin "$PWD/node/bin"; do
    [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js introuvable : 'brew install node', ou extraire l'archive macOS de nodejs.org dans le dossier \"node\" du projet."
    exit 1
fi
# Première fois, ou dépendances modifiées depuis la dernière installation (git pull)
if node server/needs-install.mjs; then
    echo "Installation des dependances..."
    npm install --omit=dev || exit 1
    node server/needs-install.mjs --done
fi
exec node server/index.mjs "$@"
