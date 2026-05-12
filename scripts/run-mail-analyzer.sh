#!/bin/bash
# Mail Analyzer - Scheduled incremental scan runner
# Called by launchd every 15 minutes.

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

cd "$(dirname "$0")/.."

mkdir -p logs

if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

echo "========================================"
echo "Mail analyzer scan started at $(date)"
echo "========================================"

npx tsx src/agent/analyze-mailbox.ts 2>&1
