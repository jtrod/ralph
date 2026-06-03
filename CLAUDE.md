# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ralph is a CLI that drives an iterative `claude -p` loop against a PRD/PROJECT file, rendering live progress (tasks, output, cost, tokens) in a `blessed` TUI. It is a thin orchestrator: each iteration spawns a fresh `claude` subprocess that reads `PROMPT.md`, does one unit of work, and the loop repeats until the agent emits a completion token, the budget/iteration cap is hit, or an error occurs.

## Commands

```bash
npm test                      # run the full test suite (node --test)
node --test test/ralph.test.js   # run one test file
npm install                   # also runs bin/setup.js postinstall (scaffolds PROMPT.md + /prd)

ralph <prd-file> [iterations=10] [--budget <usd>]   # start the loop (needs a real TTY)
ralph init                    # scaffold PROMPT.md and .claude/commands/prd.md, then exit
```

There is no build step, linter, or transpiler — this is plain Node ESM (`"type": "module"`, Node >= 18). Tests use the built-in `node:test` runner and only cover the pure functions in `lib/ralph-utils.js`; the TUI and process-spawning code in `bin/ralph.js` are not unit-tested.

## Architecture

**`bin/ralph.js`** (the whole driver, ~1200 lines) — three concerns interleaved:
- **Main loop** (`runLoop` → `runIteration`): spawns `claude -p <prompt> --output-format stream-json --verbose` and parses the NDJSON event stream line-by-line. Events are `system` (init/model), `assistant` (text + `tool_use` blocks), `user` (`tool_result` blocks), and `result` (final cost/tokens/turns). Each event mutates the global `STATE` object and pushes updates to the UI.
- **`STATE`** — a single module-level mutable object holding all loop, cost, task, and UI state. Everything flows through it; there is no other store.
- **TUI** (`createUi`): a `blessed-contrib` grid with two dashboard modes (standard / analytics) plus toggleable task and agent-tree panels. `createUi` returns a bag of `update*`/`set*` methods that the loop calls; the UI never reaches back into the loop.

**`lib/ralph-utils.js`** — all pure, side-effect-free helpers (formatting, `parseTestOutput`, `parseGitDiffStat`, `computeEta`/`computeBurnRate`, `summarizeToolUse`, and PRD task parsing). New testable logic belongs here, not in `bin/ralph.js`.

**Loop termination** is decided in `runLoop` by inspecting each iteration's result, in priority order: spawn error → user-canceled → user-skipped → non-zero exit → `<promise>COMPLETE</promise>` token in output (regex `COMPLETE_TOKEN`) → budget exceeded (pauses, does not exit) → max iterations.

### Two things drive the agent's behavior

1. **`PROMPT.md`** (in the *target* project's cwd, not this repo) is the literal prompt sent every iteration. `buildPromptBody` reads it and replaces the `@PROJECT.md` placeholder with `@<actual-prd-path>`. The agent is expected to do one task per iteration and print `<promise>COMPLETE</promise>` when the whole project is done. The template lives in `templates/PROMPT.md`.

2. **PRD task parsing** (`parsePrdTasksFromContent`) feeds the task list / progress gauge. It tries a **strict** format first — tasks like `- [ ] **T1: title — description**` grouped under `### W1: ...` headings inside an `## ...Tasks` section (`TASK_LINE_RE`, `WORK_GROUP_RE`) — and falls back to **any** `- [ ]` checkbox grouped under `**US1 ...**` headings if no strict tasks are found. The PRD file is watched (`fs.watch`) and re-parsed (debounced) as the agent edits it, so progress updates live.

### Scaffolding

`bin/setup.js` (npm `postinstall`) and `ralph init` both copy `templates/PROMPT.md` → cwd and `templates/prd.md` → `.claude/commands/prd.md` (the `/prd` slash command). `setup.js` walks up out of `node_modules` to find the consuming project root and fails silently so it never breaks `npm install`; `runInit` is the explicit, verbose equivalent.

**`ralph.sh`** is a minimal headless fallback (no TUI, no cost tracking) for CI / non-TTY environments — `bin/ralph.js` hard-exits if `stdout` is not a TTY.

## Conventions

- ESM only — use `import`, `.js` extensions in relative imports, `node:` prefix for builtins.
- blessed markup tags (`{green-fg}...{/green-fg}`) are used throughout UI strings; preserve them when editing labels.
- Keep `bin/ralph.js` orchestration-only; extract anything with logic worth testing into `lib/ralph-utils.js` and add `node:test` cases.
