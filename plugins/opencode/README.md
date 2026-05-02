# Terminal Bell

An OpenCode plugin that rings your terminal bell when a session completes, goes idle, needs permission, encounters an error, or asks a question.

Designed for macOS with support for multiple terminal emulators and intelligent focus detection to avoid additional ringing when your terminal is already in focus.

## Installation

1. Copy `terminal-bell.ts` to your OpenCode plugins directory:

```bash
cp terminal-bell.ts ~/.config/opencode/plugins/terminal-bell.ts
```

2. Make sure OpenCode is configured to load plugins from that directory.

3. On first run, your terminal will request "System Events" permissions in macOS System Settings. Grant them to enable focus detection.

## Supported Terminals

- **Terminal** (macOS built-in)
- **iTerm2**
- **kitty** — requires `allow_remote_control yes` in `~/.config/kitty/kitty.conf`
- **Ghostty** — requires a build with tty/pid support (late April 2026 or later)
- **WezTerm**
- **Alacritty**

## How It Works

When a matching event fires, the plugin:

1. Rings the bell once via `afplay` and a raw bell character (`\x07`)
2. Checks if your terminal window is in focus
3. If the terminal is not focused, rings again after a configurable interval
4. Guarantees at least `MIN_PLAY_COUNT` beeps, then stops if the terminal comes into focus
5. Repeats up to `MAX_PLAY_COUNT` total beeps
6. Skips if the cooldown period hasn't passed since the last trigger

## Configuration

Edit the constants at the top of `terminal-bell.ts`:

| Constant | Default | Description |
|----------|---------|-------------|
| `MIN_PLAY_COUNT` | `2` | Guaranteed minimum beeps before focus check applies |
| `MAX_PLAY_COUNT` | `5` | Maximum total beeps per trigger |
| `WAIT_INTERVAL` | `3000` | Milliseconds between bell repeats |
| `COOLDOWN_MS` | `30000` | Minimum ms between separate bell triggers |
| `BELL_CHAR` | `"\x07"` | Raw bell character written to stdout |
| `BELL_SOUND` | `"/System/Library/Sounds/Ping.aiff"` | macOS system sound used by `afplay` |
| `LOG_ENABLED` | `true` | Enable debug logging to `terminal-bell.log` |

Trigger event types (configured via `TRIGGER_EVENT_TYPES`):

- `session.idle`
- `permission.asked`
- `session.error`
- `question.asked`

## Requirements

- **macOS** — uses `afplay` and AppleScript
- **Bun** — runtime for the plugin
- **System Events permission** — granted on first run for focus detection

## Credit

Based on the original terminal bell gist by [ahosker](https://gist.github.com/ahosker/267f375a65378bcb9a867fd9a195db1e), which included contributions from [CarlosGtrz](https://x.com/CarlosGtrz/status/1969623801240412281), [silentjay](https://github.com/silentjay), [philharmonie](https://github.com/philharmonie), [Sleepful](https://github.com/Sleepful), and [Tenrys](https://github.com/Tenrys).

This version extends the original with multi-terminal support, focus detection, cooldown logic, and subagent session filtering.

## License

MIT. See [LICENSE](LICENSE).
