# Ralph

Drive iterative development loops with Claude using a live TUI dashboard. Ralph spawns `claude -p` processes against a PRD/PROJECT file, displays real-time progress including task completion, code changes, test results, and resource usage, then advances automatically or manually between iterations.

**Perfect for:** Building features or prototypes end-to-end with AI agents while maintaining full visibility into what's happening and staying within budget.

---

## Quick Start

### Install globally with npm

```bash
npm i -g github:jtrod/ralph
ralph init                # Scaffold PROMPT.md and install /prd command
```

Then in Claude Code, run `/prd` to generate your PROJECT.md, then:

```bash
ralph PROJECT.md
```

### Use in a single project

```bash
npm i -D github:jtrod/ralph
npx ralph PROJECT.md
```

### Run once without installing

```bash
npx github:jtrod/ralph init
npx github:jtrod/ralph PROJECT.md 15 --budget 5
```

---

## System Requirements

- **Node.js** >= 18
- **Claude CLI** on your PATH ([install here](https://docs.claude.com/claude-code))
- **Terminal:** Real TTY for the dashboard UI; use `ralph.sh` for CI/non-TTY environments
- **Optional:** `git` for diff statistics, `osascript` on macOS for completion notifications

---

## How It Works

Ralph automates iterative development by:

1. **Reading your PRD/PROJECT file** — tasks with a `## Tasks` section and structured checkboxes
2. **Spawning `claude -p` with your PROMPT.md + PROJECT.md** — Claude reads the files and works on the highest-priority uncompleted task
3. **Displaying real-time progress** — in a dashboard showing tasks, output, files modified, tests, cost, and tokens
4. **Advancing automatically or manually** — iteration proceeds when Claude prints `<promise>COMPLETE</promise>`, hits the iteration cap, or exceeds the budget
5. **Tracking everything** — aggregate stats, burndown, cost/token history, and git diffs across all iterations

---

## Usage

### Command Syntax

```bash
ralph <prd-file> [iterations=10] [--budget <usd>]
ralph init
```

**Arguments:**
- `<prd-file>` — Path to your PROJECT.md or PRD file
- `[iterations=10]` — Max iterations to run (default: 10)
- `[--budget <usd>]` — Max USD to spend; pauses when exceeded

**Commands:**
- `init` — Scaffold PROMPT.md and install the `/prd` command helper into `.claude/commands/prd.md`

### Examples

```bash
# Run 10 iterations with default settings
ralph PROJECT.md

# Run up to 20 iterations
ralph PROJECT.md 20

# Stop automatically if cost exceeds $5
ralph PROJECT.md 10 --budget 5

# Run once, no dashboard (for CI)
./ralph.sh PROJECT.md
```

---

## Dashboard Navigation

When Ralph is running, you'll see a live TUI with five panels:

| Panel | Purpose |
|-------|---------|
| **Header** | Current iteration, elapsed time, total cost/tokens, burn rate, ETA |
| **Tasks** | Checklist of work items from your PRD; checked off as Claude completes them |
| **Output** | Live log of agent activity, tool calls, and messages |
| **Files** | Files modified in this iteration and their operation types (read/write/edit) |
| **Git / Tests** | Current git diff stats and test pass/fail/skip counts |

**Optional Analytics Dashboard:** Cost sparkline, token usage bar chart, budget gauge (toggle with `d`)

**Keybindings:**

| Key | Action |
|-----|--------|
| `q` | Quit Ralph |
| `c` | Cancel the current iteration |
| `s` | Skip the current iteration |
| `p` | Pause / resume the loop |
| `t` | Toggle task panel ↔ full-width log |
| `d` | Toggle standard dashboard ↔ analytics view |
| `f` | Cycle log filter: all → tool → error → text → all |
| `a` | Toggle the agent tree overlay (shows Claude's subagent structure) |
| `tab` | Cycle focus: tasks → output → files → tasks (focused panel scrolls with arrow keys / Page Up/Down) |

---

## Project File (PRD) Format

Ralph recognizes two formats:

### 1. Structured Format (Recommended)

The `/prd` command generates this automatically:

```markdown
## Tasks

### W1: Core Features

- [ ] **T1: User authentication** — Implement sign-up and login
- [ ] **T2: Dashboard layout** — Create the main dashboard UI
- [x] **T3: Database schema** — Set up PostgreSQL

### W2: Polish

- [ ] **T4: Error handling** — Add user-friendly error messages
```

Ralph parses:
- Level-2 heading `## Tasks` to find the task section
- Level-3 headings `### W1:`, `### W2:`, etc. as work groups
- Task lines matching `- [ ] **TID: title** — detail`
  - `TID` can be any alphanumeric identifier (T1, FEATURE-1, etc.)
  - `[ ]` = incomplete, `[x]` or `[X]` = complete
  - The detail after `—` is optional

### 2. Fallback Format

If no structured `## Tasks` section exists, Ralph falls back to simple checkboxes:

```markdown
- [ ] Build the login form
- [ ] Add password reset
- [x] Write tests
```

Each checkbox becomes a task. Titles longer than 80 characters are truncated.

---

## PROMPT.md and PROJECT.md

Ralph's loop uses two files:

**PROMPT.md** (scaffolded by `ralph init`)
- Contains agent instructions and guidelines
- Gets instantiated once per iteration, with `@PROJECT.md` replaced by your actual file
- Template includes: "Find the highest-priority task and implement it", "Update PROJECT.md", "Commit changes"

**PROJECT.md** (or your custom PRD)
- Checked by Claude each iteration to see what's complete
- Contains your feature list, scope, constraints, API design, etc.
- Ralph tracks which tasks are complete by monitoring checkbox state

As Claude works, it updates the checkboxes in PROJECT.md. Ralph detects the change and advances the UI.

---

## Features

### Real-Time Metrics

Ralph tracks and displays:

- **Cost** — Total USD spent (input + output tokens × model pricing)
- **Tokens** — Input and output token counts per iteration and in aggregate
- **Duration** — Wall-clock time per iteration and ETA for remaining work
- **Burn rate** — USD/minute (useful for spotting expensive iterations)
- **Files touched** — Count and operation type (read/write/edit) per iteration
- **Tests** — Pass/fail/skip counts parsed from test output
- **Git diff** — Files changed, insertions, deletions

All stats reset per iteration and accumulate across the session. Visualized in two dashboard modes:

1. **Standard** — Task list, output log, file operations, tests, git diff
2. **Analytics** — Cost sparkline, token distribution bar chart, budget utilization gauge

### Task Parsing

Ralph's task parser recognizes:
- Markdown checkboxes: `- [ ]` or `- [x]`
- Structured PRD format with work groups
- Task IDs like `T1`, `FEATURE-5`, `DB-SCHEMA-1`
- Multi-line tasks via continuation (fallback mode)

When Claude checks off a task in PROJECT.md, Ralph:
1. Detects the file change
2. Re-parses the task list
3. Updates the TUI in real-time

### Budget Control

Pass `--budget <usd>` to auto-pause when spending exceeds the limit:

```bash
ralph PROJECT.md 20 --budget 5
```

Ralph tracks cumulative cost. When exceeded:
1. Current iteration completes
2. Loop pauses automatically
3. You can review and decide whether to resume

### Fallback Mode (CI/Non-TTY)

For headless environments (GitHub Actions, cron jobs, etc.), use `ralph.sh`:

```bash
./ralph.sh PROJECT.md 10
```

This runs the loop without a dashboard — just stdout logging. Still tracks cost, tokens, and tasks, but outputs are text-only.

---

## How Claude Stays in Sync

Ralph expects Claude's PROMPT.md to:

1. **Read @PROJECT.md** — Agent sees the current task list
2. **Pick one task** — Focus on highest priority / first incomplete
3. **Implement and test** — Make changes, run tests
4. **Update @PROJECT.md** — Check off completed task with `[x]`
5. **Commit and push** — Save progress to git
6. **Output completion signal** — Print `<promise>COMPLETE</promise>` when all tasks are done (optional; loop also exits on iteration cap or budget)

The bundled PROMPT.md template does all of this. You can customize it for your workflow.

---

## What Ralph Parses from Claude's Output

Ralph extracts from the `claude -p` response:

| Item | Extracted From | Used For |
|------|----------------|----------|
| Tool calls | `<function_calls>` blocks | File tracking, analytics |
| Cost | `Cost: $X.XX` in the output | Burn rate, ETA, budget check |
| Tokens | `Tokens: XXXXX input, XXXXX output` | Analytics, burndown |
| Tasks complete | Checkbox state in PROJECT.md | Task list update, exit condition |
| Tests | stdout/stderr from Bash tool | Test results widget |
| Files | Tool call `file_path` / `path` params | Files touched widget |
| Subagents | `<task>` / `<agent>` tags | Agent tree overlay |

---

## Advanced Usage

### Multiple Projects

Ralph works with any directory. Each one can have its own PROJECT.md and PROMPT.md:

```bash
cd project-a
ralph PROJECT.md

cd ../project-b
ralph PROJECT.md 20 --budget 10
```

### Customizing PROMPT.md

After `ralph init`, edit PROMPT.md to change agent behavior:

```markdown
# Agent instructions

- Find the highest-priority task in @PROJECT.md.
- Write tests before implementing (TDD style).
- Use TypeScript for all new code.
- Commit with conventional commit format.
```

### Viewing Agent Tree

Press `a` during a run to see the subagent structure. Useful when Claude delegates work to parallel agents or creates child tasks.

### Filtering the Log

Press `f` to cycle through log filters:
- `all` — Every message
- `tool` — Only tool calls (Bash, Read, Write, Edit, etc.)
- `error` — Errors and warnings only
- `text` — Agent text output only

Great for debugging or focusing on specific aspects of a run.

### Pausing and Resuming

Press `p` to pause mid-iteration. Ralph will:
1. Cancel the current `claude -p` process
2. Hold all state (cost, tokens, tasks)
3. Resume when you press `p` again

Use this to inspect output, review changes, or let a long iteration complete while keeping the dashboard live.

---

## Configuration

Ralph uses sensible defaults and does **not** require a config file. To customize defaults per project, edit `.claude/commands/prd.md` after `ralph init` to adjust how Claude generates your PRD/PROJECT file.

Ralph itself does not use settings files; all behavior is controlled via:
- Command-line arguments (`--budget`, iteration count)
- Keyboard controls in the TUI
- Your PROMPT.md instructions

---

## Troubleshooting

### "PROMPT.md not found"

Run `ralph init` in your project directory first. This scaffolds PROMPT.md and the `/prd` command.

### "claude CLI not found"

Ensure the `claude` command is on your PATH. [Install Claude Code](https://docs.claude.com/claude-code).

### "PRD file not found"

Check that the file exists and the path is correct. Use absolute or relative paths:

```bash
ralph ./PROJECT.md          # relative
ralph /path/to/PROJECT.md   # absolute
```

### Dashboard looks broken / no output

Ralph needs a real TTY. If running in a container or CI, use `ralph.sh` instead:

```bash
./ralph.sh PROJECT.md
```

### Agent not updating PROJECT.md

Check your PROMPT.md. It should instruct Claude to update `@PROJECT.md` (which gets replaced with your file path) and mark tasks as complete with `[x]`.

### Budget limit not working

`--budget` stops the loop *between* iterations. A single expensive iteration may exceed the limit. To be strict, run with fewer iterations or multiple smaller budgets:

```bash
ralph PROJECT.md 5 --budget 5   # each 5-iter batch has a $5 limit
```

---

## Examples

### Simple feature build

```bash
npx ralph init
# In Claude Code: /prd "User authentication system"
# ... generates PROJECT.md
npx ralph PROJECT.md 10 --budget 3
```

**Result:** Claude implements your auth system, checks off tasks, and you monitor cost in real-time.

### CI integration

```bash
npx ralph init
./ralph.sh PROJECT.md 5   # no dashboard, text output only
```

Add to GitHub Actions, GitLab CI, or your deployment pipeline.

### Prototyping with budget control

```bash
npx ralph init
# Create a PROJECT.md with 3-5 core tasks
npx ralph PROJECT.md 20 --budget 10   # Let Claude iterate, stop if cost exceeds $10
```

---

## Implementation Details

### Architecture

Ralph consists of:

- **bin/ralph.js** (1179 lines)
  - Main entry point and TUI orchestration
  - Spawns `claude -p` subprocess per iteration
  - Manages dashboard lifecycle
  - Keyboard handling and rendering

- **lib/ralph-utils.js** (212 lines)
  - Task parsing (structured and fallback formats)
  - Metric formatting (cost, tokens, time)
  - Test output parsing (pest, PHPUnit, Jest patterns)
  - File operation classification
  - ETA and burn rate computation

- **templates/PROMPT.md**
  - Starter agent instructions (editable)
  - References `@PROJECT.md` and `@PROGRESS.md`

- **templates/prd.md**
  - Installed as `.claude/commands/prd.md`
  - Generates structured PRDs with JTBD, user stories, scope, API design, etc.

### Data Flow

```
CLI args
   ↓
Parse PRD → Task list
   ↓
Spawn claude -p with PROMPT + PROJECT
   ↓
Read subprocess output line-by-line
   ↓
Extract cost, tokens, tools, test results
   ↓
Update TUI panels
   ↓
Detect PROJECT.md change → Re-parse tasks
   ↓
Check for COMPLETE token or exit condition
   ↓
Next iteration or exit
```

### State Management

Ralph maintains STATE across iterations:
- `tasks` — Current task list
- `totalCost`, `totalInputTokens`, `totalOutputTokens` — Cumulative metrics
- `iterCosts`, `iterTokens`, `iterDurationsMs` — Per-iteration history
- `filesTouchedMap` — Deduplicated file operations
- `testResults` — Aggregate pass/fail counts
- `agentTree` — Subagent hierarchy from tags
- `logEntries` — Bounded log buffer (max 10,000 lines)

---

## Acknowledgements

Inspired by the [Ralph Wiggum Technique](https://laracasts.com/series/the-ralph-wiggum-technique) — a method of iterative development where one AI agent reads a brief, makes progress, then hands off to the next iteration.

---

## License

MIT
