import { execSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

const PLIST_NAME = "com.agenthub.newsletter";
const PLIST_PATH = join(
  process.env.HOME || "/Users/bricks",
  "Library/LaunchAgents",
  `${PLIST_NAME}.plist`
);
const PROJECT_DIR = join(process.cwd());

interface ScheduleConfig {
  enabled: boolean;
  time: string; // "HH:mm"
  days: number[]; // 0=Sun ... 6=Sat
}

/**
 * Generates a macOS LaunchAgent plist XML for the newsletter agent.
 * Supports multiple weekday intervals.
 */
function buildPlist(schedule: ScheduleConfig): string {
  const [hour, minute] = schedule.time.split(":").map(Number);

  // If all 7 days selected (or empty = every day), use a single interval without Weekday
  const allDays =
    schedule.days.length === 0 ||
    schedule.days.length === 7;

  let calendarIntervals: string;

  if (allDays) {
    calendarIntervals = `    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>`;
  } else {
    // Multiple intervals — one per selected weekday
    const dicts = schedule.days
      .sort((a, b) => a - b)
      .map(
        (day) => `        <dict>
            <key>Weekday</key>
            <integer>${day}</integer>
            <key>Hour</key>
            <integer>${hour}</integer>
            <key>Minute</key>
            <integer>${minute}</integer>
        </dict>`
      )
      .join("\n");

    calendarIntervals = `    <key>StartCalendarInterval</key>
    <array>
${dicts}
    </array>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PROJECT_DIR}/scripts/run-agent.sh</string>
    </array>
${calendarIntervals}
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/logs/launchd-out.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/logs/launchd-err.log</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`;
}

/**
 * Syncs the schedule config to the macOS LaunchAgent.
 * - If schedule is enabled: writes plist + loads it
 * - If schedule is disabled: unloads + removes plist
 */
export function syncScheduleToLaunchAgent(schedule: ScheduleConfig): {
  success: boolean;
  message: string;
} {
  try {
    // Always try to unload first (ignore errors if not loaded)
    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch {
      // Not loaded, that's fine
    }

    if (!schedule.enabled) {
      return {
        success: true,
        message: "Schedule disabled — LaunchAgent unloaded",
      };
    }

    // Write updated plist
    const plistContent = buildPlist(schedule);
    writeFileSync(PLIST_PATH, plistContent);

    // Load the new plist
    execSync(`launchctl load "${PLIST_PATH}"`);

    const [hour, minute] = schedule.time.split(":").map(Number);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayStr =
      schedule.days.length === 7 || schedule.days.length === 0
        ? "every day"
        : schedule.days.map((d) => dayNames[d]).join(", ");

    return {
      success: true,
      message: `Schedule synced — runs at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${dayStr}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to sync schedule: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
