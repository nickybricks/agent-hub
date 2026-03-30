#!/bin/bash
# Install the launchd scheduler for the Newsletter Summarizer agent
# This runs the agent daily at 08:30

PLIST_NAME="com.agenthub.newsletter"
PLIST_SOURCE="$(dirname "$0")/../com.agenthub.newsletter.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "Installing Agent Hub newsletter scheduler..."

# Unload if already loaded
launchctl list | grep -q "$PLIST_NAME" && launchctl unload "$PLIST_DEST" 2>/dev/null

# Copy plist
cp "$PLIST_SOURCE" "$PLIST_DEST"

# Load
launchctl load "$PLIST_DEST"

echo "Scheduler installed. The newsletter agent will run daily at 08:30."
echo "To uninstall: launchctl unload $PLIST_DEST && rm $PLIST_DEST"
