# Ralph

Drive iterative development loops with Claude using a live TUI dashboard. Ralph spawns `claude -p` processes against a PROJECT file, displaying real-time progress in tasks, output, and cost.

See [ralph-prd.md](ralph-prd.md) for detailed documentation.

## Quick Start

```bash
npm install github:jtrod/ralph
ralph init
```

`ralph init` scaffolds `PROMPT.md` and installs the `/prd` command into `.claude/commands/prd.md`. Both are required before running ralph.

Then in Claude Code, run `/prd` to generate your `PROJECT.md`:

```
/prd "describe your project here"
```

Then start the loop:

```bash
ralph PROJECT.md
```

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
