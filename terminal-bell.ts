import type { Plugin } from "@opencode-ai/plugin";

const PLAY_COUNT = 3;          // total repetitions
const WAIT_INTERVAL = 5000;    // ms between repeats
const TERMINALS = ["iTerm.app","Terminal.app"];

async function isTerminalFocused($) {
  const frontmost = await $`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`;
  return TERMINALS.includes(frontmost.stdout.trim());
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

      if (event.type === "session.idle" || event.type === "permission.asked") {
        await playAlert($);                           // always plays at least once
        for (let i = 1; i < PLAY_COUNT; i++) {         // remaining repeats
          await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL));
          if (!await isTerminalFocused($)) break;       // check AFTER timeout
          await playAlert($);
        }
      }
    },
  };
};
