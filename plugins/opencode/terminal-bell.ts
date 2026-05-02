import fs from "fs/promises";
import type { BunShell } from "@opencode-ai/plugin/shell";

// note to users: make sure Bun is installed
// this script requires your terminal program to have "System Events" permissions, which will be asked for on first execution

// ─── Configuration ────────────────────────────────────────────────────────────

const MIN_PLAY_COUNT = 2; // guaranteed beeps
const MAX_PLAY_COUNT = 5; // maximum total beeps
const WAIT_INTERVAL = 3000; // ms between repeats
const COOLDOWN_MS = 30_000; // min ms between separate bell trigger events
let lastBellTimestamp = Date.now() - COOLDOWN_MS; // epoch ms of last trigger
const BELL_CHAR = "\x07";
const BELL_SOUND = "/System/Library/Sounds/Ping.aiff";
const TRIGGER_EVENT_TYPES = [
  "session.idle",
  "permission.asked",
  "session.error",
  "question.asked",
];

// Terminals tested and supported (process names match .app/Contents/MacOS/<name>)
// iTerm2: process name for iTerm. has a python API that could be easier than our approach, but ours works without Magic - Python API enabled
// kitty: to fully work, add the lines 'allow_remote_control yes' and 'listen_on unix:{kitty_pid}' to ~/.config/kitty/kitty.conf
// Ghostty: Requires a build with tty/pid on terminal objects, late April 2026 or later
// wezterm-gui: process name for WezTerm. doesn't expose enough data, so I use a get-text comparison with a subprocess trick to make it work
// Alacritty: doesn't expose enough data, so we just do a best effort here
const TERMINALS = [
  "Terminal",
  "iTerm2",
  "kitty",
  "Ghostty",
  "wezterm-gui",
  "Alacritty",
];

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_ENABLED = true;
const LOG_PATH = `${import.meta.dir}/terminal-bell.log`;

async function log(...args: unknown[]): Promise<void> {
  if (!LOG_ENABLED) return;
  const ts = new Date().toISOString();
  await fs.appendFile(LOG_PATH, `[${ts}] ${args.join(" ")}\n`);
}

// ─── TTY Helpers ─────────────────────────────────────────────────────────────

function normalizeTTY(tty: string | null): string {
  if (!tty) return "";
  return tty.replace(/^\/dev\//, "").trim();
}

async function walkProcessTree(
  $: BunShell,
  startPid: number,
  column: string,
  onValue: (value: string) => string | null,
): Promise<string | null> {
  let currentPid = startPid;
  while (currentPid && !isNaN(currentPid) && currentPid !== 1) {
    const result =
      await $`ps -co ${column}=,ppid= -p ${currentPid} 2>/dev/null`.quiet();
    const line = result.stdout.toString().trim();
    if (!line) break;
    const tokens = line.split(/\s+/);
    currentPid = parseInt(tokens.pop() || "1", 10);
    const columnValue = tokens.join(" ") || "";
    if (!columnValue) break;
    const matched = onValue(columnValue);
    if (matched !== null) return matched;
  }
  return null;
}

// ─── AppleScript Runner ──────────────────────────────────────────────────────

const TTY_FETCH_SCRIPTS: Record<string, string> = {
  terminal: `tell application "Terminal"
  return (tty of front window) as text
end tell`,
  iterm2: `tell application "iTerm2"
  return tty of current session of current tab of current window
end tell`,
  ghostty: `tell application "Ghostty"
  return (tty of focused terminal of selected tab of front window) as text
end tell`,
};

async function runAppleScript($: BunShell, script: string): Promise<string> {
  try {
    const result = await $`osascript -e ${script} 2>/dev/null`.quiet();
    const raw = result.stdout.toString().trim();
    await log("AppleScript output:", JSON.stringify(raw));
    return raw;
  } catch (err) {
    await log(
      `AppleScript: ERROR running: ${script} with result ${String(err)}`,
    );
    return "";
  }
}

// ─── kitty Focus Handling ────────────────────────────────────────────────────

// in kitty, self has frontmost focus only if every node it is inside also has focus
function hasSelfInFocusChain(node: Record<string, unknown>): boolean {
  const isFocused = (node.is_focused as boolean | undefined) ?? true;
  if (!isFocused) return false;
  if (node.is_self) return true;

  // Recurse into children: tabs or windows arrays
  const tabs = node.tabs as Array<Record<string, unknown>> | undefined;
  if (tabs) {
    for (const child of tabs) {
      if (hasSelfInFocusChain(child)) return true;
    }
  }

  const windows = node.windows as Array<Record<string, unknown>> | undefined;
  if (windows) {
    for (const child of windows) {
      if (hasSelfInFocusChain(child)) return true;
    }
  }

  return false;
}

async function isKittyFocused($: BunShell): Promise<boolean> {
  try {
    const result = await $`kitty @ ls 2>/dev/null`.quiet();
    const raw = result.stdout.toString().trim();
    if (!raw) {
      await log(
        "isKittyFocused: no kitty @ ls output (remote control may not be enabled)",
      );
      return false;
    }

    let data = JSON.parse(raw);
    for (const w of data as Array<Record<string, unknown>>) {
      if (hasSelfInFocusChain(w)) {
        await log("isKittyFocused: our process is in the focused chain");
        return true;
      }
    }

    await log("isKittyFocused: our process is not in the focused chain");
    return false;
  } catch (err) {
    await log("isKittyFocused: ERROR", String(err));
    return false;
  }
}

// ─── Focus Checkers ──────────────────────────────────────────────────────────

async function checkFocusedTTY(
  $: BunShell,
  getFocusedTTY: () => Promise<string | null>,
): Promise<boolean> {
  let ourTTY = normalizeTTY(
    await walkProcessTree($, process.pid, "tty", (tty) => {
      if (tty && tty !== "??") {
        return tty;
      }
      return null;
    }),
  );
  if (!ourTTY) {
    await log(`checkFocusedTTY: no session TTY found`);
    return false;
  }
  const focused = normalizeTTY(await getFocusedTTY());
  if (!focused) {
    await log(`checkFocusedTTY: no focused window found`);
    return false;
  }
  if (focused === ourTTY) {
    await log(`checkFocusedTTY: TTY match — our session is focused`);
    return true;
  }
  await log(`checkFocusedTTY: TTY mismatch — our=${ourTTY} focused=${focused}`);
  return false;
}

async function checkWezTermFocused($: BunShell): Promise<boolean> {
  const ourPane = process.env.WEZTERM_PANE;
  await log("checkWezTermFocused: WEZTERM_PANE=", JSON.stringify(ourPane));
  if (!ourPane) {
    await log("checkWezTermFocused: no WEZTERM_PANE set");
    return false;
  }
  let activeText = "";
  try {
    const result =
      await $`zsh -c 'env -u WEZTERM_PANE wezterm cli get-text' 2>/dev/null`.quiet();
    activeText = result.stdout.toString().trim();
  } catch (err) {
    await log("checkWezTermFocused: get-text failed:", String(err));
    return false;
  }
  let ourText = "";
  try {
    const result =
      await $`wezterm cli get-text --pane-id ${ourPane} 2>/dev/null`.quiet();
    ourText = result.stdout.toString().trim();
  } catch (err) {
    await log("checkWezTermFocused: get-text --pane-id failed:", String(err));
    return false;
  }
  await log(
    "checkWezTermFocused:",
    "active=",
    JSON.stringify(activeText.substring(0, 100)),
    "our=",
    JSON.stringify(ourText.substring(0, 100)),
  );
  if (activeText !== "" && activeText === ourText) {
    await log("checkWezTermFocused: text match — our pane is focused");
    return true;
  }
  await log("checkWezTermFocused: no text match — another pane has focus");
  return false;
}

async function checkAlacrittyFocused($: BunShell): Promise<boolean> {
  const focusedTitle = await runAppleScript(
    $,
    `
tell application "System Events"
  return title of front window of process "Alacritty"
end tell`,
  );
  if (
    focusedTitle &&
    (focusedTitle.startsWith("OC | ") || focusedTitle === "OpenCode")
  ) {
    await log("checkAlacrittyFocused: focused title matches opencode window");
    return true;
  }
  await log(
    "checkAlacrittyFocused: focused title=",
    JSON.stringify(focusedTitle),
    "— not an opencode window",
  );
  return false;
}

// ─── Focus Orchestration ─────────────────────────────────────────────────────

async function isTerminalFocused($: BunShell): Promise<boolean> {
  const terminalName = await walkProcessTree($, process.pid, "comm", (comm) => {
    const commName = comm.split("/").pop() || comm;
    if (TERMINALS.some((t) => t.toLowerCase() === commName.toLowerCase())) {
      return commName;
    }
    return null;
  });
  if (!terminalName) {
    await log("isTerminalFocused: no terminal found");
    return false;
  }

  try {
    await log("isTerminalFocused: name=", terminalName);
    const frontmost = await runAppleScript(
      $,
      `tell application "System Events" to get frontmost of process "${terminalName}"`,
    );
    if (frontmost !== "true") {
      await log("isTerminalFocused: app not frontmost");
      return false;
    }

    const lower = terminalName.toLowerCase();
    switch (lower) {
      case "kitty":
        return await isKittyFocused($);
      case "wezterm-gui":
        return await checkWezTermFocused($);
      case "alacritty":
        return await checkAlacrittyFocused($);
      default:
        if (TTY_FETCH_SCRIPTS[lower]) {
          return await checkFocusedTTY(
            $,
            async () => await runAppleScript($, TTY_FETCH_SCRIPTS[lower]),
          );
        }
        return true;
    }
  } catch (err) {
    await log("isTerminalFocused: ERROR", String(err));
    return false;
  }
}

// ─── Alert ───────────────────────────────────────────────────────────────────

async function playAlert($: BunShell, label: string): Promise<void> {
  const elapsed = Date.now() - lastBellTimestamp;
  const sleepMs = Math.max(0, WAIT_INTERVAL - elapsed);
  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  await log("playAlert", label);
  lastBellTimestamp = Date.now();
  await Bun.write(Bun.stdout, BELL_CHAR);
  try {
    await $`afplay ${BELL_SOUND} 2>/dev/null`.quiet();
  } catch (err) {
    await log("afplay FAILED", label, String(err));
  }
}

// ─── Plugin Entry Point ──────────────────────────────────────────────────────

export const TerminalBell: Plugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  // Erase log on opencode start / plugin loading
  if (LOG_ENABLED) await fs.rm(LOG_PATH, { force: true }).catch(() => {});
  await log("Cleared log for new opencode instance");

  return {
    // opencode event types are in a types.gen.ts file
    event: async ({ event }) => {
      // Skip subagent sessions — they run independently without needing user attention
      if (event.type === "session.idle" && event.properties.sessionID) {
        try {
          const session = await client.session.get({
            path: { id: event.properties.sessionID },
          });
          if (session.data.parentID) {
            await log("SKIP subagent session", event.properties.sessionID);
            return;
          }
        } catch {
          /* ignore lookup errors */
        }
      }

      if (!TRIGGER_EVENT_TYPES.includes(event.type)) return;

      await log("EVENT", event.type, JSON.stringify(event.properties));

      let elapsed = Date.now() - lastBellTimestamp;
      if (elapsed < COOLDOWN_MS) {
        await log("COOLDOWN skip", `${elapsed}ms / ${COOLDOWN_MS}ms`);
        return;
      }

      let focused = false;
      for (let i = 0; i < MAX_PLAY_COUNT; i++) {
        if (!focused) {
          focused = await isTerminalFocused($);
        }
        if (i >= MIN_PLAY_COUNT && focused) break;
        await playAlert($, `beep ${i + 1}`);
      }
    },
  };
};
