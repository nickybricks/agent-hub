#!/bin/bash
# Agent Hub - Production Server Startup Script
# Used by macOS LaunchAgent to auto-start on login

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production

cd /Users/bricks/Developer/mail-workflow

# Log output
exec >> /Users/bricks/Developer/mail-workflow/logs/server.log 2>&1

echo "========================================"
echo "Starting Agent Hub at $(date)"
echo "========================================"

# Start Next.js production server on all interfaces
npx next start -H 0.0.0.0 -p 3000
