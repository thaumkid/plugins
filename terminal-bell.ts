import type { Plugin } from "@opencode-ai/plugin";

const PLAY_COUNT = 3;          // total repetitions
const WAIT_INTERVAL = 5000;    // ms between repeats
const COOLDOWN_MS = 30_000;    // min seconds between bell triggers
let lastBellTimestamp = 0;     // epoch ms of last trigger

interface TerminalApp {
  name: string;           // matches .app/Contents/MacOS/<name> in process comm  
  eventsName: string;     // System Events process name (usually same as `name`)
}

// note: these haven't all been tested
const TERMINALS: TerminalApp[] = [
  { name: "Terminal", eventsName: "Terminal" },
  { name: "iTerm2", eventsName: "iTerm2" },
  { name: "Ghostty", eventsName: "Ghostty" },
  { name: "WezTerm", eventsName: "WezTerm" },
  { name: "kitty", eventsName: "kitty" },
  { name: "Alacritty", eventsName: "Alacritty" },
];

async function getParentTerminal($) {
  try {
    // Use Node.js process.pid to reliably get our current PID,
    // avoiding shell expansion issues with $$ and macOS ps quirks.
    const pid = process.pid;

    let currentPid = pid;

    while (currentPid && !isNaN(currentPid) && currentPid !== 1) {
      const commResult = await $`ps -o comm= -p ${currentPid} > /dev/null 2>&1`;
      const comm = commResult.stdout.trim();

      if (!comm) break; // process no longer exists

      for (const term of TERMINALS) {
        if (comm.includes(`.app/Contents/MacOS/${term.name}`)) {
          return term.eventsName;
        }
      }

      const parentResult = await $`ps -o ppid= -p ${currentPid} > /dev/null 2>&1`;
      currentPid = parseInt(parentResult.stdout.trim(), 10);
    }

    return null;
  } catch {
    return null;
  }
}

async function isTerminalFocused($) {
  const terminal = await getParentTerminal($);
  if (!terminal) return false;

  try {
    const frontmost = await $`osascript -e 'tell application "System Events" to get frontmost of process "${terminal}"' 2>/dev/null`;
    return frontmost.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function playAlert($) {
  await Bun.write(Bun.stdout, "\x07");
  try {
    await $`afplay /System/Library/Sounds/Ping.aiff`;
  } catch (err) {
    console.warn("Failed to play audible bell:", err);
  }
}

export const TerminalBell: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    event: async ({ event }) => {
      // Skip subagent sessions — they run independently without needing user attention
      if (event.type === "session.idle" && event.properties.sessionID) {
        try {
          const session = await client.session.get({ path: { id: event.properties.sessionID } });
          if (session.parentID) return;  // child/subagent session, skip
        } catch { /* ignore lookup errors */ }
      }

      if (event.type === "session.idle" || event.type === "permission.asked" || event.type === "session.error" || event.type === "question.asked") {
        if (Date.now() - lastBellTimestamp < COOLDOWN_MS) return;
        await playAlert($);                           // always plays at least once
        
        lastBellTimestamp = Date.now();
        for (let i = 1; i < PLAY_COUNT; i++) {         // remaining repeats
          await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL));
          if (await isTerminalFocused($)) break;         // user returned attention, stop ringing
          await playAlert($);
        }
      }
    },
  };
};
