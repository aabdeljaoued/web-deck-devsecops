#!/bin/sh
# Installe le deck comme service de session macOS (LaunchAgent, sans droits admin) :
#   - démarre à l'ouverture de session, sans fenêtre Terminal ;
#   - redémarre tout seul s'il s'arrête sur une erreur (ou via Réglages › Redémarrer) ;
#   - journal : ~/Library/Logs/web-deck-devsecops.log
# Désinstaller : service/uninstall-mac.sh (ou service/desinstaller.command)
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
LABEL="local.web-deck-devsecops"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/web-deck-devsecops.log"
DOMAIN="gui/$(id -u)"

# Échappement XML des chemins (&, <, >)
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>$(xml "$ROOT/start.sh")</string>
        <string>--no-open</string>
    </array>
    <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DECK_SUPERVISOR</key><string>launchd</string>
        <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <!-- Relancé s'il s'arrête sur un code d'erreur (plantage, Redémarrer) ; pas après un arrêt normal -->
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>$(xml "$LOG")</string>
    <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

# Ancienne version du service, puis deck lancé à la main (fenêtre Terminal) : arrêtés pour libérer le port.
# Les terminaux ouverts sont rouverts au démarrage du service.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if pgrep -f "node server/index.mjs" >/dev/null; then
    echo "Arrêt du deck lancé à la main (les terminaux seront rouverts)..."
    pkill -f "node server/index.mjs" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "node server/index.mjs" >/dev/null || break; sleep 0.5; done
fi

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Service installé : $LABEL"
echo "  Journal : $LOG"

# Ouvre le deck une fois le serveur prêt
for _ in $(seq 1 30); do
    [ -f "$ROOT/.deck-token" ] && curl -s -o /dev/null "http://127.0.0.1:$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$ROOT/config.jsonc" | head -1)/" && break
    sleep 0.5
done
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$ROOT/config.jsonc" | head -1)
open "http://127.0.0.1:${PORT:-7777}/?token=$(cat "$ROOT/.deck-token")"
