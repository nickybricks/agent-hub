#!/bin/bash
# Install the launchd scheduler for the Mail Analyzer
# Runs incremental scans every 15 minutes.

PLIST_NAME="com.agenthub.mail-analyzer"
PLIST_SOURCE="$(dirname "$0")/../com.agenthub.mail-analyzer.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Installing Mail Analyzer scheduler..."

launchctl list | grep -q "$PLIST_NAME" && launchctl unload "$PLIST_DEST" 2>/dev/null

cp "$PLIST_SOURCE" "$PLIST_DEST"
launchctl load "$PLIST_DEST"

echo "Scheduler installed. The mail analyzer will run every 15 minutes."
echo "To uninstall: launchctl unload $PLIST_DEST && rm $PLIST_DEST"
