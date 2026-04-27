import fs from "fs/promises";

// note to users: make sure Bun is installed
// this script does require your terminal program to have automation permissions

const PLAY_COUNT = 3;          // total repetitions
const WAIT_INTERVAL = 3000;    // ms between repeats
const COOLDOWN_MS = 15_000;    // min ms between bell triggers
let lastBellTimestamp = 0;     // epoch ms of last trigger

const LOG_ENABLED = true;
const LOG_PATH = `${import.meta.dir}/terminal-bell.log`;
async function log(...args: unknown[]) {
  if (!LOG_ENABLED) return;
  const ts = new Date().toISOString();
  await fs.appendFile(LOG_PATH, `[${ts}] ${args.join(" ")}\n`);
}

interface TerminalApp {
  name: string;           // matches .app/Contents/MacOS/<name> in process comm  
  eventsName: string;     // System Events process name (usually same as `name`)
  hasScripting: boolean;  // supports AppleScript window PID queries
}

// note: only the first 3 have been tested
const TERMINALS: TerminalApp[] = [
  { name: "Terminal", eventsName: "Terminal", hasScripting: true },
  { name: "iTerm2", eventsName: "iTerm2", hasScripting: true }, // has a python API that is much easier than our approach, but requires making the terminal less safe
  { name: "kitty", eventsName: "kitty", hasScripting: false },
  { name: "Ghostty", eventsName: "Ghostty", hasScripting: false },
  { name: "WezTerm", eventsName: "WezTerm", hasScripting: false },
  { name: "Alacritty", eventsName: "Alacritty", hasScripting: false },
];

interface TerminalInfo {
  eventsName: string;
  pid: number;
}

async function queryPid($, pid: number, column: string) {
  const result = await $`ps -o ${column}= -p ${pid} 2>/dev/null`.quiet();
  return result.stdout.toString().trim();
}

async function getParentTerminal($) {
  try {
    // Use Node.js process.pid to reliably get our current PID,
    // avoiding shell expansion issues with $$ and macOS ps quirks.
    const pid = process.pid;
    await log("getParentTerminal: starting from pid", pid);

    let currentPid = pid;
    let depth = 0;

    while (currentPid && !isNaN(currentPid) && currentPid !== 1) {
      const comm = await queryPid($, currentPid, "comm");
      await log("getParentTerminal depth", depth, "pid", currentPid, "comm:", comm);

      if (!comm) break; // process no longer exists

      const commName = comm.split("/").pop() || comm;

      for (const term of TERMINALS) {
        if (commName === term.name) {
          await log("getParentTerminal: FOUND terminal", term.name, "eventsName:", term.eventsName, "pid:", currentPid);
          return { eventsName: term.eventsName, pid: currentPid };
        }
      }

      currentPid = parseInt(await queryPid($, currentPid, "ppid"), 10);
      depth++;
    }

    await log("getParentTerminal: no terminal found in tree");
    return null;
  } catch (err) {
    await log("getParentTerminal: ERROR", String(err));
    return null;
  }
}

async function getFocusedWindowPid(eventsName: string, $) {
  if (eventsName === "iTerm2") {
    try {
      // Check if iTerm2 is frontmost via System Events
      const frontmost = await $`osascript -e 'tell application "System Events" to get frontmost of process "iTerm2"' 2>/dev/null`.quiet();
      if (frontmost.stdout.toString().trim() !== "true") { return null; }

      // Get iTerm2's unix id from System Events
      const result = await $`osascript -e 'tell application "System Events" to get unix id of process "iTerm2"' 2>/dev/null`.quiet();
      const raw = result.stdout.toString().trim();
      if (!raw) { return null; }
      const pid = parseInt(raw, 10);
      await log("getFocusedWindowPid iTerm2: parsed unix id:", pid, "isNaN:", isNaN(pid));
      return isNaN(pid) ? null : pid;
    } catch (err) {
      await log("getFocusedWindowPid iTerm2: AppleScript failed:", String(err));
      return null;
    }
  }

  // Terminal.app returns null here; TTY-based check is done in isTerminalFocused.
  await log("getFocusedWindowPid: returning null for", eventsName);
  return null;
}

async function getSessionTTY($) {
  let pid = process.pid;
  while (pid && !isNaN(pid) && pid !== 1) {
    const tty = await queryPid($, pid, "tty");
    if (tty && tty !== "??") {
      return tty.trim();
    }
    pid = parseInt(await queryPid($, pid, "ppid"), 10);
  }
  return null;
}

async function getFocusedIterm2TabTTYS($) {
  // Use AppleScript (not JXA) because JXA cannot resolve iTerm2 session objects in this version.
  // Since System Events already confirms iTerm2 is frontmost, we use "current window" directly
  // instead of looping all windows with the broken "focused" property check.
  
  const appleScript = `
tell application "iTerm2"
  try
    set t to current tab of current window
    set ttyList to {}
    repeat with s in sessions of t
      set theTTY to tty of s as text
      if theTTY starts with "/dev/" then
        set end of ttyList to (text 6 thru -1 of theTTY)
      else if theTTY is not "" then
        set end of ttyList to theTTY
      end if
    end repeat
    set AppleScript's text item delimiters to linefeed
    return ttyList as text
  on error errMsg number errNum
    return "ERROR:" & errNum & "|" & errMsg
  end try
end tell
`;

  const result = await $`osascript -e ${appleScript}`.quiet();
  const raw = result.stdout.toString().trim();
  await log("getFocusedIterm2TabTTYS: AppleScript output:", JSON.stringify(raw));
  
  if (!raw || raw.startsWith("ERROR:") || raw === "") { return []; }
  
  const ttys = raw.split("\n").map(t => t.trim()).filter(Boolean).map(normalizeTTY).filter(Boolean);
  await log("getFocusedIterm2TabTTYS: parsed ttys:", JSON.stringify(ttys));
  return ttys;
}

async function getFocusedTerminalAppTabTTY($) {
  const result = await $`osascript -e 'tell application "Terminal"' -e 'repeat with w from 1 to (count of windows)' -e 'tell window w' -e 'try' -e 'if frontmost then return (tty as text)' -e 'end try' -e 'end tell' -e 'end repeat' -e 'return ""' -e 'end tell' 2>/dev/null`.quiet();
  const raw = result.stdout.toString().trim();
  if (!raw) { await log("getFocusedTerminalAppTabTTY: no frontmost window found"); return null; }
  await log("getFocusedTerminalAppTabTTY: raw output:", JSON.stringify(raw));
  // Normalize "/dev/ttysXXX" -> "ttysXXX" for comparison
  const normalized = raw.replace(/^\/dev\//, "");
  await log("getFocusedTerminalAppTabTTY: normalized to", JSON.stringify(normalized));
  return normalized;
}

function normalizeTTY(tty: string | null): string {
  if (!tty) return "";
  return tty.replace(/^\/dev\//, "").trim();
}

async function isTerminalFocused($) {
  const terminal = await getParentTerminal($);
  if (!terminal) { await log("isTerminalFocused: no terminal found"); return false; }

  try {
    // Quick check: app must be frontmost
    const frontmost = await $`osascript -e 'tell application "System Events" to get frontmost of process "${terminal.eventsName}"' 2>/dev/null`.quiet();
    const frontmostVal = frontmost.stdout.toString().trim();
    await log("isTerminalFocused: eventsName=", terminal.eventsName, "pid=", terminal.pid, "frontmost=", frontmostVal);
    if (frontmostVal !== "true") { await log("isTerminalFocused: app not frontmost"); return false; }

    // iTerm2: use TTY-based comparison since getFocusedWindowPid returns main app unix_id (never matches shell pid)
    if (terminal.eventsName === "iTerm2") {
      let ourTTY = "";
      try {
        ourTTY = normalizeTTY(await getSessionTTY($));
      } catch (err) {
        await log("isTerminalFocused iTerm2: failed to get our TTY:", String(err));
      }
      let focusedTabTTYS: string[] = [];
      try {
        focusedTabTTYS = await getFocusedIterm2TabTTYS($);
      } catch (err) {
        await log("isTerminalFocused iTerm2: getFocusedIterm2TabTTYS failed — another session likely has focus");
        return false;
      }
      await log("isTerminalFocused iTerm2: ourTTY=", JSON.stringify(ourTTY), "focusedTabTTYS=", JSON.stringify(focusedTabTTYS));
      if (ourTTY !== "" && focusedTabTTYS.length > 0) {
        if (focusedTabTTYS.includes(ourTTY)) {
          await log("isTerminalFocused iTerm2: TTY match — our session is in a focused tab");
          return true;
        }
      }
      await log("isTerminalFocused iTerm2: no TTY match — another session has focus, continuing bell");
      return false;
    }

    // For scriptable terminals that support per-window PID detection, compare directly
    const focusedPid = await getFocusedWindowPid(terminal.eventsName, $);
    if (focusedPid !== null) {
      await log("isTerminalFocused: focusedPid=", focusedPid, "our pid=", terminal.pid);
      if (focusedPid === terminal.pid || await isDescendantOf(focusedPid, terminal.pid, $)) {
        await log("isTerminalFocused: PID match via focused window");
        return true;
      }
    }

    // Terminal.app: compare our session TTY with the focused tab's TTY via AppleScript
    if (terminal.eventsName === "Terminal") {
      const ourTTY = await getSessionTTY($);
      const focusedTabTTY = await getFocusedTerminalAppTabTTY($);
      await log("isTerminalFocused Terminal.app: ourTTY=", JSON.stringify(ourTTY), "focusedTabTTY=", JSON.stringify(focusedTabTTY));
      if (normalizeTTY(ourTTY) === normalizeTTY(focusedTabTTY)) {
        await log("isTerminalFocused: TTY match — our tab is focused");
        return true;
      }
      await log("isTerminalFocused: TTY mismatch — another tab has focus, continuing bell");
      return false;
    }

    // For unscriptable terminals, verify we are running inside the terminal by walking ancestor chain
    await log("isTerminalFocused: falling back to check if in focused terminal");
    return await isInFrontmostTerminal(process.pid, terminal.eventsName, $);
  } catch (err) {
    await log("isTerminalFocused: ERROR", String(err));
    return false;
  }
}

async function isDescendantOf(childPid: number, ancestorPid: number, $) {
  try {
    await log("isDescendantOf: checking if", childPid, "is descendant of", ancestorPid);
    let currentPid = childPid;
    let depth = 0;
    while (currentPid && !isNaN(currentPid) && currentPid !== 1 && currentPid !== ancestorPid) {
      const ppid = parseInt(await queryPid($, currentPid, "ppid"), 10);
      await log("isDescendantOf depth", depth, "pid", currentPid, "ppid", ppid);
      if (isNaN(ppid)) { await log("isDescendantOf: isNaN ppid"); return false; }
      if (ppid === ancestorPid) { await log("isDescendantOf: MATCH at depth", depth); return true; }
      currentPid = ppid;
      depth++;
    }
    await log("isDescendantOf: no match, stopped at pid", currentPid);
    return false;
  } catch (err) {
    await log("isDescendantOf: ERROR", String(err));
    return false;
  }
}

async function isInFrontmostTerminal(pid: number, frontmostName: string, $) {
  try {
    await log("isInFrontmostTerminal: checking if pid", pid, "runs inside frontmost terminal:", frontmostName);

    // Walk up our ancestor chain to find which terminal app we're running in
    let currentPid = pid;
    let depth = 0;
    const MAX_DEPTH = 15;

    while (currentPid && !isNaN(currentPid) && currentPid !== 1 && depth < MAX_DEPTH) {
      const comm = await queryPid($, currentPid, "comm");
      if (!comm) break;

      const commName = comm.split("/").pop() || comm;

      for (const term of TERMINALS) {
        if (commName === term.name) {
          // Found which terminal we're running in - check if it's frontmost
          await log("isInFrontmostTerminal: found ancestor terminal", term.name, "at depth", depth);
          const frontmost = await $`osascript -e 'tell application "System Events" to get frontmost of process "${term.eventsName}"' 2>/dev/null`.quiet();
          const val = frontmost.stdout.toString().trim();
          await log("isInFrontmostTerminal:", term.name, "frontmost=", val);
          return val === "true";
        }
      }

      currentPid = parseInt(await queryPid($, currentPid, "ppid"), 10);
      depth++;
    }

    // No terminal ancestor found - we're not running inside a known terminal app
    await log("isInFrontmostTerminal: no terminal ancestor found");
    return false;
  } catch (err) {
    await log("isInFrontmostTerminal: ERROR", String(err));
    return false;
  }
}

async function isOurChildFrontmost(ourPid: number, $) {
  try {
    await log("isOurChildFrontmost: checking descendants of pid=", ourPid);

    // Walk entire descendant tree recursively using a BFS approach
    let currentLevel = [ourPid];
    let depth = 0;
    const MAX_DEPTH = 10;

    while (currentLevel.length > 0 && depth < MAX_DEPTH) {
      const nextLevel: number[] = [];
      
      for (const pid of currentLevel) {
        // Check cmdline for opencode at this level
        try {
          const cmd = await queryPid($, pid, "args");
          await log("isOurChildFrontmost depth", depth, "pid", pid, "cmd:", cmd.substring(0, 120));
          if (cmd.includes('opencode')) {
            await log("isOurChildFrontmost: FOUND opencode at pid", pid, "depth", depth);
            return true;
          }
        } catch { /* process may have exited */ }

        // Get children for next level
        try {
          const childResult = await $`ps -o pid= --ppid ${pid} 2>/dev/null`.quiet();
          const childPids = childResult.stdout.toString().trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
          nextLevel.push(...childPids);
        } catch { /* may fail for some pids */ }
      }

      currentLevel = nextLevel;
      depth++;
    }

    await log("isOurChildFrontmost: no opencode found in descendants (checked to depth", MAX_DEPTH, ")");
    return false;
  } catch (err) {
    await log("isOurChildFrontmost: ERROR", String(err));
    return false;
  }
}

async function playAlert($, label = "") {
  log("playAlert", label || "first");
  await Bun.write(Bun.stdout, "\x07");
  try {
    await $`afplay /System/Library/Sounds/Ping.aiff`.quiet();
    log("afplay OK", label);
  } catch (err) {
    console.warn("Failed to play audible bell:", err);
    log("afplay FAILED", label, String(err));
  }
}

export const TerminalBell: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    event: async ({ event }) => {

      // Skip subagent sessions — they run independently without needing user attention
      if (event.type === "session.idle" && event.properties.sessionID) {
        try {
          const session = await client.session.get({ path: { id: event.properties.sessionID } });
            log("SESSION idle", JSON.stringify(session));
          if (session.parentID) { log("SKIP subagent session", event.properties.sessionID); return; }
        } catch { /* ignore lookup errors */ }
      }

      const isTriggerEvent = event.type === "session.idle" || event.type === "permission.asked" || event.type === "session.error" || event.type === "question.asked"; // question.asked event not documented, but definitely exists and found here - https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/question/index.ts
      if (!isTriggerEvent) return;
      
      log("EVENT", event.type, JSON.stringify(event.properties));

      const elapsed = Date.now() - lastBellTimestamp;
      if (elapsed < COOLDOWN_MS) { log("COOLDOWN skip", `${elapsed}ms / ${COOLDOWN_MS}ms`); return; }

      await playAlert($, "first");

      lastBellTimestamp = Date.now();
      for (let i = 1; i < PLAY_COUNT; i++) {         // remaining repeats
        log("WAITING before repeat", i + 1, `(${elapsed}ms since cooldown)`);
        await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL));
        const focused = await isTerminalFocused($);
        if (focused) { log("TERMINAL FOCUSED — stopping repeats"); break; }
        log("TERMINAL NOT FOCUSED — playing repeat", i + 1);
        await playAlert($, `repeat ${i + 1}`);
      }
    },
  };
};
