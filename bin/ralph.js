#!/usr/bin/env node

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
    formatElapsed, formatCost, formatTokens,
    classifyFileOp, parseTestOutput, parseGitDiffStat,
    computeEta, computeBurnRate, summarizeToolUse,
    parsePrdTasksFromContent,
    escapeTags,
} from '../lib/ralph-utils.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

const COMPLETE_TOKEN = /<promise>COMPLETE<\/promise>/;
const SIGKILL_GRACE_MS = 3000;
const HEADER_TICK_MS = 1000;
const PAUSE_POLL_MS = 200;
const FILE_WATCH_DEBOUNCE_MS = 200;
const MAX_LOG_ENTRIES = 10_000;
const LOG_FILTERS = ['all', 'tool', 'error', 'text'];

const STATE = {
    child: null,
    canceled: false,
    skipped: false,
    paused: false,
    iter: 0,
    maxIters: 0,
    iterStartedAt: 0,
    sessionStartedAt: 0,
    ui: null,
    prdPath: '',
    lastStatus: 'idle',
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTurns: 0,
    currentTaskId: null,
    tasks: [],
    iterHistory: [],
    _prdDebounce: null,

    iterCosts: [],
    iterTokens: [],
    filesTouchedMap: new Map(),
    iterDurationsMs: [],
    lastGitStat: null,
    testResults: { passed: 0, failed: 0, skipped: 0 },
    budget: null,
    pausedTotalMs: 0,
    pauseStartedAt: null,
    agentTree: { name: 'ralph', extended: true, children: {} },
    logFilter: 'all',
    logEntries: [],
    dashboardMode: 'standard',
};

// ─── CLI ────────────────────────────────────────────────────────────────────

function printUsage(stream) {
    (stream ?? process.stdout).write(`Usage: ralph <prd-file> [iterations=10] [--budget <usd>]
       ralph init

Drive an iterative claude -p loop against a PRD file with a live TUI.

Commands:
  init          Scaffold PROMPT.md and install the /prd command into the
                current project (.claude/commands/prd.md), then exit.

Arguments:
  <prd-file>    Path to the PRD/project file the agent will read and update.
  iterations    Max iterations before giving up. Default: 10.

Options:
  --budget <n>  Max USD to spend. Auto-pauses when exceeded.
  -h, --help    Print this help and exit.

Keys (inside the TUI):
  q  Quit           c  Cancel iteration    s  Skip iteration
  p  Pause/resume   t  Toggle task list    d  Toggle dashboard mode
  f  Cycle log filter (all/tool/error/text)
  a  Toggle agent tree     tab  Cycle panel focus
`);
}

function copyTemplate(templateName, destPath) {
    if (fs.existsSync(destPath)) {
        process.stdout.write(`  skipped (exists): ${destPath}\n`);
        return;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATES_DIR, templateName), destPath);
    process.stdout.write(`  created: ${destPath}\n`);
}

function runInit() {
    process.stdout.write('Scaffolding Ralph into the current project...\n');
    copyTemplate('PROMPT.md', path.resolve('PROMPT.md'));
    copyTemplate('prd.md', path.resolve('.claude', 'commands', 'prd.md'));
    process.stdout.write(
        '\nNext steps:\n' +
        '  1. Run /prd in Claude Code to generate a ralph-compatible PROJECT.md\n' +
        '  2. ralph PROJECT.md        # start the loop\n',
    );
}

function parseArgs(argv) {
    const raw = argv.slice(2);
    if (raw.includes('-h') || raw.includes('--help')) return { help: true };

    let budget = null;
    const positional = [];

    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '--budget') {
            budget = parseFloat(raw[++i]);
            if (isNaN(budget) || budget <= 0) {
                return { error: `--budget must be a positive number, got: ${raw[i]}` };
            }
            continue;
        }
        positional.push(raw[i]);
    }

    const [prdPath, itersRaw] = positional;
    if (!prdPath) return { error: 'missing <prd-file>' };
    if (!fs.existsSync(path.resolve(prdPath))) return { error: `PRD file not found: ${prdPath}` };
    if (!fs.existsSync('PROMPT.md')) return { error: 'PROMPT.md not found in current directory (run `ralph init` to scaffold it)' };

    const maxIters = itersRaw === undefined ? 10 : Number(itersRaw);
    if (!Number.isInteger(maxIters) || maxIters <= 0) {
        return { error: `iterations must be a positive integer, got: ${itersRaw}` };
    }

    return { prdPath, maxIters, budget };
}

function buildPromptBody(prdPath) {
    return fs.readFileSync('PROMPT.md', 'utf8').replaceAll('@PROJECT.md', `@${prdPath}`);
}

// ─── PRD Task Parsing ───────────────────────────────────────────────────────

function parsePrdTasks(filePath) {
    try {
        return parsePrdTasksFromContent(fs.readFileSync(path.resolve(filePath), 'utf8'));
    } catch (_) {
        return [];
    }
}

function debouncedPrdReparse(filePath, ui) {
    clearTimeout(STATE._prdDebounce);
    STATE._prdDebounce = setTimeout(() => {
        try {
            const parsed = parsePrdTasks(filePath);
            if (parsed.length > 0 || STATE.tasks.length === 0) {
                STATE.tasks = parsed;
                ui.updateTaskList(STATE.tasks);
            }
        } catch (_) { /* file mid-write */ }
    }, FILE_WATCH_DEBOUNCE_MS);
}

function setupPrdWatcher(filePath, ui) {
    const resolved = path.resolve(filePath);
    const watcher = fs.watch(path.dirname(resolved), (_, filename) => {
        if (filename !== path.basename(resolved)) return;
        debouncedPrdReparse(filePath, ui);
    });
    watcher.unref();
    return watcher;
}

// ─── File Tracking ──────────────────────────────────────────────────────────

function trackFileOp(filePath, op) {
    const short = path.basename(filePath);
    const entry = STATE.filesTouchedMap.get(short) || { ops: new Set(), count: 0, fullPath: filePath };
    entry.ops.add(op);
    entry.count++;
    STATE.filesTouchedMap.set(short, entry);
}

// ─── Git Diff ───────────────────────────────────────────────────────────────

function fetchGitDiffStat() {
    try {
        const out = execSync('git diff --shortstat HEAD', { timeout: 5000, encoding: 'utf8' });
        return parseGitDiffStat(out);
    } catch (_) {
        return null;
    }
}

// ─── OS Notification ────────────────────────────────────────────────────────

function sendNotification(title, message) {
    try {
        const safeTitle = title.replace(/["\\]/g, '');
        const safeMessage = message.replace(/["\\]/g, '');
        const child = spawn('osascript', [
            '-e', `display notification "${safeMessage}" with title "${safeTitle}" sound name "Glass"`,
        ]);
        child.unref();
        child.on('error', () => {});
    } catch (_) { /* silent */ }
}

// ─── TUI ────────────────────────────────────────────────────────────────────

function createUi(maxIters, prdPath) {
    const screen = blessed.screen({ smartCSR: true, title: 'Ralph', fullUnicode: true });
    const grid = new contrib.grid({ rows: 16, cols: 12, screen });

    // ── Shared panels (both modes) ──

    const header = grid.set(0, 0, 3, 12, blessed.box, {
        label: ' Ralph ',
        border: { type: 'line' },
        tags: true,
        style: { border: { fg: 'cyan' } },
    });

    const activity = grid.set(4, 0, 1, 12, blessed.box, {
        tags: true,
        style: { fg: 'white' },
    });

    const history = grid.set(13, 0, 2, 12, blessed.box, {
        tags: true,
        style: { fg: 'white' },
    });

    const agentTreeWidget = grid.set(5, 0, 7, 12, contrib.tree, {
        label: ' agents ',
        border: { type: 'line' },
        tags: true,
        style: { border: { fg: 'magenta' }, fg: 'white' },
        template: { extend: ' ▸', retract: ' ▾', lines: true },
        hidden: true,
    });
    agentTreeWidget.setData(STATE.agentTree);
    let agentTreeVisible = false;

    // Pinned to the absolute bottom line instead of being proportioned as the
    // last row of the contrib.grid — contrib.grid rounds the bottom-most row to
    // a thin strip that some terminals clip, so the footer could be invisible.
    // An absolute bottom:0 box always lands on the last visible line. Appended
    // after the grid so it draws on top; the now-unused grid row 15 sits empty
    // beneath the bottom panels (history stays at rows 13–14, no overlap).
    const keybindingsBar = blessed.box({
        bottom: 0,
        left: 0,
        width: '100%',
        height: 1,
        tags: true,
        style: { fg: 'white' },
    });
    screen.append(keybindingsBar);

    // ── Standard mode panels ──

    const gauge = grid.set(3, 0, 1, 12, contrib.gauge, {
        label: ' tasks ',
        stroke: 'green',
        fill: 'white',
        showLabel: true,
    });
    gauge.setPercent(0);

    const taskList = grid.set(5, 0, 7, 4, blessed.list, {
        label: ' tasks ',
        border: { type: 'line' },
        tags: true,
        scrollable: true,
        mouse: true,
        keys: true,
        scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'yellow' } },
        style: { border: { fg: 'yellow' }, selected: { bg: 'default', fg: 'default' } },
    });

    const log = grid.set(5, 4, 7, 5, blessed.log, {
        label: ' output ',
        border: { type: 'line' },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'cyan' } },
        style: { border: { fg: 'grey' } },
    });

    const filesTouchedWidget = grid.set(5, 9, 7, 3, blessed.list, {
        label: ' files ',
        border: { type: 'line' },
        tags: true,
        scrollable: true,
        mouse: true,
        keys: true,
        scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'green' } },
        style: { border: { fg: 'green' }, selected: { bg: 'default', fg: 'default' } },
    });

    const logFull = grid.set(5, 0, 7, 12, blessed.log, {
        label: ' output ',
        border: { type: 'line' },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'cyan' } },
        style: { border: { fg: 'grey' } },
        hidden: true,
    });

    const gitSummary = grid.set(12, 0, 1, 7, blessed.box, {
        label: ' git ',
        border: { type: 'line' },
        tags: true,
        style: { border: { fg: 'blue' }, fg: 'white' },
    });
    gitSummary.setContent(' {gray-fg}no git changes{/gray-fg}');

    const testResultsWidget = grid.set(12, 7, 1, 5, blessed.box, {
        label: ' tests ',
        border: { type: 'line' },
        tags: true,
        style: { border: { fg: 'green' }, fg: 'white' },
    });
    testResultsWidget.setContent(' {gray-fg}no tests{/gray-fg}');

    // ── Analytics mode panels (hidden initially) ──

    const budgetGauge = grid.set(3, 0, 1, 12, contrib.gauge, {
        label: ' budget ',
        stroke: 'green',
        fill: 'white',
        showLabel: true,
        hidden: true,
    });

    const costSparkline = grid.set(5, 0, 3, 6, contrib.sparkline, {
        label: ' cost/iter ',
        tags: true,
        style: { fg: 'green', titleFg: 'green', border: { fg: 'green' } },
        border: { type: 'line' },
        hidden: true,
    });

    const tokenBar = grid.set(5, 6, 3, 6, contrib.bar, {
        label: ' tokens/iter ',
        barWidth: 4,
        barSpacing: 2,
        xOffset: 0,
        showText: true,
        barBgColor: 'cyan',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        hidden: true,
    });

    const analyticsLog = grid.set(8, 0, 5, 12, blessed.log, {
        label: ' output ',
        border: { type: 'line' },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'cyan' } },
        style: { border: { fg: 'grey' } },
        hidden: true,
    });

    // ── Panel groups for toggling ──

    const standardPanels = [gauge, taskList, log, filesTouchedWidget, gitSummary, testResultsWidget];
    const analyticsPanels = [budgetGauge, costSparkline, tokenBar, analyticsLog];
    let taskPanelVisible = true;

    // ── Panel focus / scroll ──

    for (const panel of [taskList, log, filesTouchedWidget, logFull, analyticsLog]) {
        panel._baseBorderFg = panel.style.border.fg;
        panel.on('focus', () => {
            panel.style.border.fg = 'cyan';
            screen.render();
        });
        panel.on('blur', () => {
            panel.style.border.fg = panel._baseBorderFg;
            screen.render();
        });
    }

    function visibleFocusables() {
        if (agentTreeVisible) {
            return [agentTreeWidget];
        }
        if (STATE.dashboardMode === 'analytics') {
            return [analyticsLog];
        }
        if (taskPanelVisible) {
            return [taskList, log, filesTouchedWidget];
        }
        return [logFull];
    }

    function cycleFocus(direction) {
        const panels = visibleFocusables();
        if (panels.length === 0) {
            return;
        }
        const current = panels.indexOf(screen.focused);
        const next = current < 0
            ? 0
            : (current + direction + panels.length) % panels.length;
        panels[next].focus();
        screen.render();
    }

    // ── UI methods ──

    function renderHeader(status) {
        STATE.lastStatus = status;
        const elapsed = formatElapsed(STATE.iterStartedAt);
        const session = formatElapsed(STATE.sessionStartedAt);
        const pauseTag = STATE.paused ? ' {yellow-fg}(PAUSED){/yellow-fg}' : '';
        const child = STATE.child ? `pid ${STATE.child.pid}` : '—';
        const cost = formatCost(STATE.totalCost);
        const tokIn = formatTokens(STATE.totalInputTokens);
        const tokOut = formatTokens(STATE.totalOutputTokens);
        const taskId = STATE.currentTaskId || '—';

        const remaining = STATE.tasks.length > 0
            ? STATE.tasks.filter(t => !t.done).length
            : STATE.maxIters - STATE.iter;
        const eta = computeEta(STATE.iterDurationsMs, remaining);

        const sessionMs = STATE.sessionStartedAt ? Date.now() - STATE.sessionStartedAt : 0;
        const activePauseMs = STATE.pauseStartedAt ? Date.now() - STATE.pauseStartedAt : 0;
        const burn = computeBurnRate(STATE.totalCost, sessionMs, STATE.pausedTotalMs + activePauseMs);

        let budgetStr = '';
        if (STATE.budget) {
            const rem = Math.max(0, STATE.budget - STATE.totalCost);
            const pct = Math.round((STATE.totalCost / STATE.budget) * 100);
            budgetStr = `  budget: {green-fg}${formatCost(rem)}{/green-fg}/${formatCost(STATE.budget)} [${pct}%]`;
        }

        header.setContent(
            ` iter {bold}${STATE.iter}/${maxIters}{/bold}` +
            `  {cyan-fg}${status}{/cyan-fg}${pauseTag}` +
            `  elapsed: ${elapsed}` +
            `  session: ${session}` +
            `  ETA: {yellow-fg}${eta}{/yellow-fg}\n` +
            ` cost: {green-fg}${cost}{/green-fg}` +
            `  tokens: ${tokIn}/${tokOut}` +
            `  burn: {magenta-fg}${burn}{/magenta-fg}` +
            `${budgetStr}\n` +
            ` task: {yellow-fg}${taskId}{/yellow-fg}` +
            `  child: ${child}` +
            `  turns: ${STATE.totalTurns}` +
            `  prd: {green-fg}${prdPath}{/green-fg}`,
        );
        screen.render();
    }

    function setIter(n) {
        STATE.iter = n;
        STATE.iterStartedAt = Date.now();
        STATE.filesTouchedMap.clear();
        STATE.testResults = { passed: 0, failed: 0, skipped: 0 };
        STATE.agentTree = { name: 'ralph', extended: true, children: {} };
        agentTreeWidget.setData(STATE.agentTree);
        updateFilesTouched();
        updateTestResults(STATE.testResults);
        renderHeader('starting');
    }

    function setStatus(status) {
        renderHeader(status);
    }

    function setActivity(text) {
        const taskDesc = currentTaskDescription();
        const suffix = taskDesc ? `  {gray-fg}| ${escapeTags(taskDesc)}{/gray-fg}` : '';
        activity.setContent(` {cyan-fg}>{/cyan-fg} ${escapeTags(text)}${suffix}`);
        screen.render();
    }

    function currentTaskDescription() {
        const task = STATE.tasks.find(t => t.id === STATE.currentTaskId);
        if (!task) return '';
        return task.description
            ? `${task.id}: ${task.title} — ${task.description}`
            : `${task.id}: ${task.title}`;
    }

    // blessed parses {...} as markup; a malformed tag (e.g. a path like
    // lang/{es,ca,en}/x.php that slipped past escaping) makes its tag parser
    // dereference null and throw, which would crash the whole run mid-task.
    // Never let one log line take the TUI down: retry with braces neutralized,
    // then give up on just that line.
    function safeLog(widget, text) {
        try {
            widget.log(text);
        } catch (_) {
            try { widget.log(escapeTags(text)); } catch (_) { /* skip unrenderable line */ }
        }
    }

    function appendTaggedLine(text, category) {
        STATE.logEntries.push({ text, category });
        if (STATE.logEntries.length > MAX_LOG_ENTRIES) STATE.logEntries.shift();

        if (STATE.logFilter === 'all' || category === 'system' || STATE.logFilter === category) {
            safeLog(log, text);
            safeLog(logFull, text);
            safeLog(analyticsLog, text);
        }
        screen.render();
    }

    function applyLogFilter() {
        log.setContent('');
        logFull.setContent('');
        analyticsLog.setContent('');

        for (const entry of STATE.logEntries) {
            if (STATE.logFilter === 'all' || entry.category === 'system' || STATE.logFilter === entry.category) {
                safeLog(log, entry.text);
                safeLog(logFull, entry.text);
                safeLog(analyticsLog, entry.text);
            }
        }
        updateKeybindingsBar();
        screen.render();
    }

    function cycleLogFilter() {
        const idx = LOG_FILTERS.indexOf(STATE.logFilter);
        STATE.logFilter = LOG_FILTERS[(idx + 1) % LOG_FILTERS.length];
        applyLogFilter();
    }

    function updateTaskList(tasks) {
        const currentIdx = tasks.findIndex(t => !t.done);
        STATE.currentTaskId = currentIdx >= 0 ? tasks[currentIdx].id : 'done';

        const items = tasks.map((task, i) => {
            if (task.done) {
                return ` {green-fg}[x]{/green-fg} {green-fg}${task.id}{/green-fg} ${escapeTags(task.title)}`;
            } else if (i === currentIdx) {
                return ` {yellow-fg}[>]{/yellow-fg} {bold}{yellow-fg}${task.id}{/yellow-fg}{/bold} ${escapeTags(task.title)}`;
            }
            return ` {gray-fg}[ ] ${task.id} ${escapeTags(task.title)}{/gray-fg}`;
        });

        taskList.setItems(items);
        if (currentIdx >= 0) taskList.select(currentIdx);

        const total = tasks.length;
        const done = tasks.filter(t => t.done).length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        gauge.setPercent(pct);
        gauge.options.label = ` tasks: ${done}/${total} (${pct}%) `;
        screen.render();
    }

    function updateHistory() {
        const parts = STATE.iterHistory.map(h => {
            const icon = h.outcome === 'done' ? '{green-fg}v{/green-fg}'
                : h.outcome === 'complete' ? '{green-fg}*{/green-fg}'
                    : h.outcome === 'canceled' ? '{yellow-fg}x{/yellow-fg}'
                        : h.outcome === 'skipped' ? '{gray-fg}s{/gray-fg}'
                            : '{red-fg}!{/red-fg}';
            return `${icon} i${h.iter} ${h.duration} ${formatCost(h.cost)}`;
        });
        history.setContent(` ${parts.join('  ') || '{gray-fg}no iterations yet{/gray-fg}'}`);
        screen.render();
    }

    function updateFilesTouched() {
        const items = [];
        for (const [short, entry] of STATE.filesTouchedMap) {
            const ops = [...entry.ops];
            let color = 'cyan';
            if (ops.includes('write')) color = 'green';
            else if (ops.includes('edit')) color = 'yellow';
            const badge = ops.map(o => o[0].toUpperCase()).join('');
            items.push(` {${color}-fg}[${badge}]{/${color}-fg} ${short}`);
        }
        filesTouchedWidget.setItems(items.length > 0 ? items : [' {gray-fg}no files yet{/gray-fg}']);
        screen.render();
    }

    function updateGitSummary(stat) {
        if (!stat) {
            gitSummary.setContent(' {gray-fg}no git changes{/gray-fg}');
        } else {
            gitSummary.setContent(
                ` {green-fg}+${stat.insertions}{/green-fg}` +
                ` {red-fg}-${stat.deletions}{/red-fg}` +
                ` (${stat.filesChanged} file${stat.filesChanged !== 1 ? 's' : ''})`,
            );
        }
        screen.render();
    }

    function updateTestResults(results) {
        if (results.passed === 0 && results.failed === 0 && results.skipped === 0) {
            testResultsWidget.setContent(' {gray-fg}no tests{/gray-fg}');
        } else {
            const parts = [];
            if (results.passed > 0) parts.push(`{green-fg}${results.passed} passed{/green-fg}`);
            if (results.failed > 0) parts.push(`{red-fg}${results.failed} failed{/red-fg}`);
            if (results.skipped > 0) parts.push(`{yellow-fg}${results.skipped} skipped{/yellow-fg}`);
            testResultsWidget.setContent(` ${parts.join('  ')}`);
        }
        screen.render();
    }

    function updateBudgetGauge() {
        if (!STATE.budget) return;
        const pct = Math.min(100, Math.round((STATE.totalCost / STATE.budget) * 100));
        const remaining = Math.max(0, STATE.budget - STATE.totalCost);
        budgetGauge.options.stroke = pct < 60 ? 'green' : pct < 85 ? 'yellow' : 'red';
        budgetGauge.setPercent(pct);
        budgetGauge.options.label = ` budget: ${formatCost(STATE.totalCost)}/${formatCost(STATE.budget)} — ${formatCost(remaining)} remaining `;
        screen.render();
    }

    function updateCostSparkline() {
        const data = STATE.iterCosts.length > 0 ? STATE.iterCosts : [0];
        costSparkline.setData(['cost/iter'], [data]);
        screen.render();
    }

    function updateTokenBar() {
        const tokens = STATE.iterTokens;
        if (tokens.length === 0) {
            tokenBar.setData({ titles: ['—'], data: [0] });
            screen.render();
            return;
        }
        const maxBars = 10;
        const slice = tokens.slice(-maxBars);
        const startIdx = Math.max(0, tokens.length - maxBars);
        const titles = slice.map((_, i) => `i${startIdx + i + 1}`);
        const data = slice.map(t => Math.round((t.input + t.output) / 1000));
        tokenBar.setData({ titles, data });
        tokenBar.options.label = ` tokens/iter (k) `;
        screen.render();
    }

    function updateAgentTree() {
        agentTreeWidget.setData(STATE.agentTree);
        screen.render();
    }

    function updateKeybindingsBar() {
        keybindingsBar.setContent(
            ` {bold}[q]{/bold} quit  {bold}[c]{/bold} cancel  {bold}[s]{/bold} skip` +
            `  {bold}[p]{/bold} pause  {bold}[t]{/bold} tasks  {bold}[d]{/bold} dashboard` +
            `  {bold}[f]{/bold} filter:{cyan-fg}${STATE.logFilter}{/cyan-fg}` +
            `  {bold}[a]{/bold} agents  {bold}[tab]{/bold} focus`,
        );
        screen.render();
    }

    function toggleTaskPanel() {
        if (STATE.dashboardMode !== 'standard') return;
        closeAgentTree();
        taskPanelVisible = !taskPanelVisible;
        if (taskPanelVisible) {
            taskList.show();
            log.show();
            filesTouchedWidget.show();
            logFull.hide();
        } else {
            taskList.hide();
            log.hide();
            filesTouchedWidget.hide();
            logFull.show();
        }
        screen.render();
    }

    function switchDashboardMode() {
        closeAgentTree();
        STATE.dashboardMode = STATE.dashboardMode === 'standard' ? 'analytics' : 'standard';

        if (STATE.dashboardMode === 'analytics') {
            for (const p of standardPanels) p.hide();
            logFull.hide();
            if (STATE.budget) {
                budgetGauge.show();
                gauge.hide();
            } else {
                gauge.show();
                budgetGauge.hide();
            }
            costSparkline.show();
            tokenBar.show();
            analyticsLog.show();
            updateCostSparkline();
            updateTokenBar();
            updateBudgetGauge();
        } else {
            for (const p of analyticsPanels) p.hide();
            gauge.show();
            if (taskPanelVisible) {
                taskList.show();
                log.show();
                filesTouchedWidget.show();
                logFull.hide();
            } else {
                logFull.show();
            }
            gitSummary.show();
            testResultsWidget.show();
        }
        updateKeybindingsBar();
        screen.render();
    }

    function restoreMiddlePanels() {
        if (STATE.dashboardMode === 'analytics') {
            costSparkline.show();
            tokenBar.show();
            analyticsLog.show();
        } else if (taskPanelVisible) {
            taskList.show();
            log.show();
            filesTouchedWidget.show();
        } else {
            logFull.show();
        }
    }

    function closeAgentTree() {
        if (!agentTreeVisible) {
            return;
        }
        agentTreeVisible = false;
        agentTreeWidget.hide();
        restoreMiddlePanels();
    }

    function toggleAgentTree() {
        agentTreeVisible = !agentTreeVisible;
        if (agentTreeVisible) {
            for (const panel of [taskList, log, filesTouchedWidget, logFull, costSparkline, tokenBar, analyticsLog]) {
                panel.hide();
            }
            agentTreeWidget.setData(STATE.agentTree);
            agentTreeWidget.show();
            agentTreeWidget.focus();
        } else {
            agentTreeWidget.hide();
            restoreMiddlePanels();
        }
        screen.render();
    }

    function destroy() {
        try { screen.destroy(); } catch (_) { /* blessed throws if called twice */ }
    }

    updateKeybindingsBar();

    return {
        screen, setIter, setStatus, setActivity,
        appendTaggedLine, updateTaskList, updateHistory,
        updateFilesTouched, updateGitSummary, updateTestResults,
        updateBudgetGauge, updateCostSparkline, updateTokenBar,
        updateAgentTree, updateKeybindingsBar,
        toggleTaskPanel, switchDashboardMode, toggleAgentTree,
        cycleLogFilter, cycleFocus, renderHeader, destroy,
    };
}

// ─── Process Management ─────────────────────────────────────────────────────

function killChild(signal) {
    const child = STATE.child;
    if (!child) return;
    try { child.kill(signal); } catch (_) { /* already exited */ }
    const timer = setTimeout(() => {
        if (STATE.child === child) {
            try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
        }
    }, SIGKILL_GRACE_MS);
    timer.unref();
}

function quit(code) {
    if (STATE.child) killChild('SIGTERM');
    STATE.ui?.destroy();
    process.exit(code);
}

function cancelCurrent(ui) {
    if (!STATE.child) return;
    STATE.canceled = true;
    ui.appendTaggedLine('{yellow-fg}[canceled by user]{/yellow-fg}', 'system');
    killChild('SIGTERM');
}

function skipCurrent(ui) {
    if (!STATE.child) return;
    STATE.skipped = true;
    ui.appendTaggedLine('{yellow-fg}[skipped by user]{/yellow-fg}', 'system');
    killChild('SIGTERM');
}

function togglePause(ui) {
    STATE.paused = !STATE.paused;
    if (STATE.paused) {
        STATE.pauseStartedAt = Date.now();
    } else {
        if (STATE.pauseStartedAt) {
            STATE.pausedTotalMs += Date.now() - STATE.pauseStartedAt;
            STATE.pauseStartedAt = null;
        }
    }
    ui.appendTaggedLine(`{yellow-fg}[${STATE.paused ? 'paused' : 'resumed'}]{/yellow-fg}`, 'system');
    ui.setStatus(STATE.lastStatus);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Iteration Runner ───────────────────────────────────────────────────────

function runIteration(promptBody, ui) {
    STATE.canceled = false;
    STATE.skipped = false;

    return new Promise(resolve => {
        const child = spawn('claude', [
            '-p', promptBody,
            '--output-format', 'stream-json',
            '--verbose',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        STATE.child = child;
        ui.setStatus('running');
        ui.setActivity('starting claude...');

        let resultEvent = null;
        let assistantText = '';
        let spawnError = null;

        child.on('error', err => {
            spawnError = err;
            ui.appendTaggedLine(`{red-fg}! claude error: ${escapeTags(err.message)}{/red-fg}`, 'error');
        });

        createInterface({ input: child.stdout }).on('line', jsonLine => {
            let event;
            try { event = JSON.parse(jsonLine); } catch (_) {
                ui.appendTaggedLine(escapeTags(jsonLine), 'text');
                return;
            }

            try { processStreamEvent(event); } catch (err) {
                ui.appendTaggedLine(`{red-fg}! stream parse error: ${escapeTags(err.message)}{/red-fg}`, 'error');
            }
        });

        function processStreamEvent(event) {
            switch (event.type) {
                case 'system':
                    if (event.subtype === 'init') {
                        ui.setActivity(`model: ${event.model || 'unknown'}`);
                    }
                    break;

                case 'assistant': {
                    const content = event.message?.content || [];
                    for (const block of content) {
                        if (block.type === 'text' && block.text) {
                            if (assistantText.length < 50_000) assistantText += block.text;
                            for (const line of block.text.split('\n')) {
                                const trimmed = line.trim();
                                if (trimmed) ui.appendTaggedLine(escapeTags(trimmed), 'text');
                            }
                        }
                        if (block.type === 'tool_use') {
                            const summary = summarizeToolUse(block);
                            ui.setActivity(summary);
                            ui.appendTaggedLine(`{cyan-fg}> ${escapeTags(summary)}{/cyan-fg}`, 'tool');

                            const fileOp = classifyFileOp(block.name, block.input);
                            if (fileOp) {
                                trackFileOp(fileOp.filePath, fileOp.op);
                                ui.updateFilesTouched();
                            }

                            if ((block.name === 'Agent' || block.name === 'Task') && block.id) {
                                const desc = block.input?.description || (block.input?.prompt || '').slice(0, 40) || 'agent';
                                STATE.agentTree.children[block.id] = {
                                    name: `{yellow-fg}▸{/yellow-fg} ${escapeTags(desc)}`,
                                    extended: false,
                                    children: {},
                                };
                                ui.updateAgentTree();
                            }

                            if (block.name === 'Edit'
                                && block.input?.file_path?.endsWith(path.basename(STATE.prdPath))) {
                                debouncedPrdReparse(STATE.prdPath, ui);
                            }
                        }
                    }
                    break;
                }

                case 'user': {
                    const content = event.message?.content || [];
                    for (const block of content) {
                        if (block.type !== 'tool_result') continue;

                        if (block.tool_use_id && STATE.agentTree.children[block.tool_use_id]) {
                            const node = STATE.agentTree.children[block.tool_use_id];
                            node.name = node.name.replace('{yellow-fg}▸{/yellow-fg}', '{green-fg}✓{/green-fg}');
                            ui.updateAgentTree();
                        }

                        const resultText = typeof block.content === 'string'
                            ? block.content
                            : Array.isArray(block.content)
                                ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                                : '';

                        const testResult = parseTestOutput(resultText);
                        if (testResult) {
                            STATE.testResults = testResult;
                            ui.updateTestResults(testResult);
                        }

                        if (block.is_error) {
                            const errText = typeof block.content === 'string'
                                ? block.content
                                : JSON.stringify(block.content);
                            ui.appendTaggedLine(`{red-fg}< ${escapeTags(errText.slice(0, 300))}{/red-fg}`, 'error');
                        }
                    }
                    break;
                }

                case 'result':
                    resultEvent = event;
                    break;

                default:
                    break;
            }
        }

        createInterface({ input: child.stderr }).on('line', line => {
            ui.appendTaggedLine(`{red-fg}! ${escapeTags(line)}{/red-fg}`, 'error');
        });

        child.on('close', code => {
            const canceled = STATE.canceled;
            const skipped = STATE.skipped;
            STATE.child = null;

            const cost = resultEvent?.total_cost_usd ?? 0;
            const turns = resultEvent?.num_turns ?? 0;
            const usage = resultEvent?.usage ?? {};
            const finalText = resultEvent?.result ?? assistantText;

            STATE.totalCost += cost;
            const iterInput = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
            const iterOutput = usage.output_tokens ?? 0;
            STATE.totalInputTokens += iterInput;
            STATE.totalOutputTokens += iterOutput;
            STATE.totalTurns += turns;

            STATE.iterCosts.push(cost);
            STATE.iterTokens.push({ input: iterInput, output: iterOutput });
            STATE.iterDurationsMs.push(Date.now() - STATE.iterStartedAt);

            const gitStat = fetchGitDiffStat();
            STATE.lastGitStat = gitStat;
            ui.updateGitSummary(gitStat);
            ui.updateCostSparkline();
            ui.updateTokenBar();
            ui.updateBudgetGauge();
            ui.setActivity('iteration finished');

            resolve({ output: finalText, canceled, skipped, exitCode: code, spawnError, cost, turns });
        });
    });
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function runLoop(promptBody, ui) {
    for (let i = 1; i <= STATE.maxIters; i++) {
        while (STATE.paused) {
            ui.setStatus('paused');
            await sleep(PAUSE_POLL_MS);
        }

        ui.setIter(i);
        const result = await runIteration(promptBody, ui);

        let outcome = 'done';

        if (result.spawnError) {
            ui.setStatus('error');
            outcome = 'error';
            pushHistory(i, outcome, result.cost);
            ui.updateHistory();
            return { reason: 'spawn-error', iter: i, error: result.spawnError };
        } else if (result.canceled) {
            outcome = 'canceled';
            ui.setStatus('canceled');
        } else if (result.skipped) {
            outcome = 'skipped';
            ui.setStatus('skipped');
        } else if (result.exitCode !== 0) {
            outcome = 'error';
            ui.setStatus(`exit ${result.exitCode}`);
            pushHistory(i, outcome, result.cost);
            ui.updateHistory();
            return { reason: 'non-zero-exit', iter: i, exitCode: result.exitCode };
        } else if (COMPLETE_TOKEN.test(result.output)) {
            outcome = 'complete';
            ui.setStatus('complete');
            pushHistory(i, outcome, result.cost);
            ui.updateHistory();
            return { reason: 'complete', iter: i };
        }

        pushHistory(i, outcome, result.cost);
        ui.updateHistory();

        if (STATE.budget && STATE.totalCost >= STATE.budget && !STATE.paused) {
            STATE.paused = true;
            STATE.pauseStartedAt = Date.now();
            ui.appendTaggedLine(
                `{red-fg}[budget exceeded: ${formatCost(STATE.totalCost)}/${formatCost(STATE.budget)} — paused]{/red-fg}`,
                'system',
            );
            ui.updateBudgetGauge();
        }

        if (result.canceled || result.skipped) continue;
        ui.setStatus('iteration done');
    }

    return { reason: 'max-iters' };
}

function pushHistory(iter, outcome, cost) {
    STATE.iterHistory.push({
        iter,
        duration: formatElapsed(STATE.iterStartedAt),
        cost: cost || 0,
        outcome,
        taskId: STATE.currentTaskId,
    });
}

// ─── Finish ─────────────────────────────────────────────────────────────────

function finish(result, ui) {
    ui.destroy();

    const costSummary = ` (total cost: ${formatCost(STATE.totalCost)}, tokens: ${formatTokens(STATE.totalInputTokens)} in / ${formatTokens(STATE.totalOutputTokens)} out)`;

    let message;
    let exitCode = 0;

    switch (result.reason) {
        case 'complete':
            message = `All tasks complete after ${result.iter} iteration(s).${costSummary}`;
            process.stdout.write(`${message}\n`);
            break;
        case 'max-iters':
            message = `Reached max iterations (${STATE.maxIters}).${costSummary}`;
            process.stdout.write(`${message}\n`);
            break;
        case 'non-zero-exit':
            message = `claude exited with code ${result.exitCode} on iter ${result.iter}.${costSummary}`;
            process.stderr.write(`${message}\n`);
            exitCode = 2;
            break;
        case 'spawn-error':
            if (result.error?.code === 'ENOENT') {
                message = 'claude CLI not found on PATH.';
                process.stderr.write('claude CLI not found on PATH. Install: https://docs.claude.com/claude-code\n');
            } else {
                message = `claude failed to start: ${result.error?.message ?? 'unknown'}`;
                process.stderr.write(`${message}\n`);
            }
            exitCode = 2;
            break;
        default:
            message = 'Ralph finished.';
            break;
    }

    sendNotification('Ralph', message.slice(0, 200));
    process.exit(exitCode);
}

function registerSignalHandlers() {
    process.on('exit', () => STATE.ui?.destroy());
    process.on('SIGINT', () => quit(130));
    process.on('SIGTERM', () => quit(143));
    process.on('uncaughtException', err => {
        STATE.ui?.destroy();
        process.stderr.write(`uncaught exception: ${err.stack ?? err.message}\n`);
        process.exit(2);
    });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

function main() {
    if (process.argv[2] === 'init') {
        runInit();
        process.exit(0);
    }

    const args = parseArgs(process.argv);

    if (args.help) {
        printUsage();
        process.exit(0);
    }

    if (args.error) {
        process.stderr.write(`error: ${args.error}\n\n`);
        printUsage(process.stderr);
        process.exit(2);
    }

    if (!process.stdout.isTTY) {
        process.stderr.write('error: ralph.js requires a TTY (run from a real terminal, not a pipe)\n');
        process.exit(2);
    }

    STATE.prdPath = args.prdPath;
    STATE.maxIters = args.maxIters;
    STATE.budget = args.budget ?? null;
    STATE.sessionStartedAt = Date.now();
    STATE.tasks = parsePrdTasks(args.prdPath);

    const promptBody = buildPromptBody(args.prdPath);
    const ui = createUi(args.maxIters, args.prdPath);
    STATE.ui = ui;

    ui.updateTaskList(STATE.tasks);
    ui.updateHistory();

    const prdWatcher = setupPrdWatcher(args.prdPath, ui);

    ui.screen.key(['q', 'Q'], () => quit(1));
    ui.screen.key(['C-c'], () => quit(130));
    ui.screen.key(['c', 'C'], () => cancelCurrent(ui));
    ui.screen.key(['s', 'S'], () => skipCurrent(ui));
    ui.screen.key(['p', 'P'], () => togglePause(ui));
    ui.screen.key(['t', 'T'], () => ui.toggleTaskPanel());
    ui.screen.key(['d', 'D'], () => ui.switchDashboardMode());
    ui.screen.key(['f', 'F'], () => ui.cycleLogFilter());
    ui.screen.key(['a', 'A'], () => ui.toggleAgentTree());
    ui.screen.key(['tab'], () => ui.cycleFocus(1));
    ui.screen.key(['S-tab'], () => ui.cycleFocus(-1));

    ui.renderHeader('idle');

    const headerTick = setInterval(() => ui.renderHeader(STATE.lastStatus), HEADER_TICK_MS);
    headerTick.unref();

    registerSignalHandlers();

    runLoop(promptBody, ui)
        .finally(() => {
            clearInterval(headerTick);
            prdWatcher.close();
        })
        .then(result => finish(result, ui));
}

main();
