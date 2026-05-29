# ralph

Drive an iterative `claude -p` loop against a PRD/PROJECT file with a live terminal dashboard.

Each iteration spawns `claude -p`, points it at your PROMPT + PROJECT file, and shows progress in a TUI:
task list, output log, files touched, git diff, test results, cost/tokens, and a subagent tree. The loop stops
when the agent prints `<promise>COMPLETE</promise>`, when it hits the iteration cap, or when a `--budget` is
exceeded.

## Installation

### Install globally with npm (from GitHub)

    npm i -g github:jtrod/ralph     # installs the `ralph` command + its deps
    ralph init                      # scaffolds PROMPT.md + installs the /prd command into .claude/commands
    # then run /prd in Claude Code to generate a ralph-compatible PROJECT.md
    ralph PROJECT.md                # drive the claude -p loop with the TUI

### Add to a single project

    npm i -D github:jtrod/ralph
    npx ralph PROJECT.md

### Run once without installing

    npx github:jtrod/ralph init
    npx github:jtrod/ralph PROJECT.md 15 --budget 5

### Pin a version (tag or commit)

    npm i -g github:jtrod/ralph#v1

### Requirements

- Node >= 18 and the [`claude` CLI](https://docs.claude.com/claude-code) on your `PATH`
- A real terminal (TTY) for the TUI; use the bundled `ralph.sh` for non-TTY / CI runs (no dashboard)
- Optional: `git` (diff stats) and macOS `osascript` (completion notification)

## Usage

    ralph <prd-file> [iterations=10] [--budget <usd>]
    ralph init

`ralph init` writes a starter `PROMPT.md` to the current directory and installs the `/prd` slash command into
`.claude/commands/prd.md` (it never overwrites existing files). `PROMPT.md` references `@PROJECT.md` /
`@PROGRESS.md`; the agent reads the PROJECT file, works one task per iteration, and checks tasks off.

### Keys (inside the TUI)

| Key   | Action                                   |
| ----- | ---------------------------------------- |
| `q`   | Quit                                     |
| `c`   | Cancel the current iteration             |
| `s`   | Skip the current iteration               |
| `p`   | Pause / resume                           |
| `t`   | Toggle the task panel / full-width log   |
| `d`   | Toggle standard / analytics dashboard    |
| `f`   | Cycle the log filter (all/tool/error/text) |
| `a`   | Toggle the agents overlay                |
| `tab` | Cycle focus across the tasks/output/files panels (focused panel scrolls with arrows / pageup-down) |

## PRD format

Ralph parses tasks from your PRD/PROJECT file under a level-2 `## Tasks` heading, with `### W1:` work groups
and `- [ ] **T1: title** — detail` lines. The bundled `/prd` command (installed by `ralph init`) generates
exactly this format, so its output works natively. Hand-written or legacy PRDs that only use plain `- [ ]`
checkboxes also work via a fallback parser.

## Acknowledgements

Inspired by https://laracasts.com/series/the-ralph-wiggum-technique
