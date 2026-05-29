# Ralph

Drive iterative development loops with Claude using a live TUI dashboard. Ralph spawns `claude -p` processes against a PROJECT file, displaying real-time progress in tasks, output, and cost.

See [ralph-prd.md](ralph-prd.md) for detailed documentation.

## Quick Start

1. **Install:**
   ```bash
   npm install github:jtrod/ralph
   ```

2. **Generate your PROJECT.md** in Claude Code:
   ```
   /prd "describe your project here"
   ```

3. **Start the loop:**
   ```bash
   npx ralph PROJECT.md
   ```

Ralph auto-scaffolds `PROMPT.md` and the `/prd` command on first run, so you don't need to manually run `ralph init`.

## Usage

```bash
ralph <prd-file> [iterations=10] [--budget <usd>]
ralph init
```

**Arguments:**
- `<prd-file>` — Path to your PROJECT.md
- `[iterations=10]` — Max iterations (default: 10)
- `[--budget <usd>]` — Max USD to spend

## Requirements

- **Node.js** >= 18
- **Claude CLI** on your PATH ([install](https://docs.claude.com/claude-code))
- **Terminal:** Real TTY for dashboard; use `ralph.sh` for CI

## License

MIT
