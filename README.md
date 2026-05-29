# Ralph

Drive iterative development loops with Claude using a live TUI dashboard. Ralph spawns `claude -p` processes against a PROJECT file, displaying real-time progress in tasks, output, and cost.

See [ralph-prd.md](ralph-prd.md) for detailed documentation.

## Quick Start

### Install globally

```bash
npm i -g github:jtrod/ralph
ralph init
```

### Use in a project

```bash
npm i -D github:jtrod/ralph
npx ralph PROJECT.md
```

### Run once

```bash
npx github:jtrod/ralph init
npx github:jtrod/ralph PROJECT.md 10 --budget 5
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
