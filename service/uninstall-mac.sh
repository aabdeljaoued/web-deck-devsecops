#!/bin/sh
# Désinstalle le service de session macOS du deck (le deck s'arrête ; start.command le relance à la main).
LABEL="local.web-deck-devsecops"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Service arrêté." || echo "Service non chargé."
rm -f "$PLIST" && echo "Service désinstallé (le journal reste dans ~/Library/Logs/web-deck-devsecops.log)."
