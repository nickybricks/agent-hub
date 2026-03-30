#!/bin/bash
# Newsletter Summarizer Agent - Daily Runner
# This script is called by launchd to run the agent on schedule

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$(dirname "$0")/.."

mkdir -p logs

# Load environment variables
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

echo "========================================"
echo "Agent run started at $(date)"
echo "========================================"

# Run the agent
npx tsx src/agent/run.ts 2>&1 | tee -a logs/agent.log
