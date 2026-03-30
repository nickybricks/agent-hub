#!/bin/bash
# Uninstall the launchd scheduler

PLIST_NAME="com.agenthub.newsletter"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Uninstalling Agent Hub newsletter scheduler..."
launchctl unload "$PLIST_DEST" 2>/dev/null
rm -f "$PLIST_DEST"
echo "Scheduler removed."
