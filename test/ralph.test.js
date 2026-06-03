import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    formatElapsed, formatCost, formatTokens,
    classifyFileOp, parseTestOutput, parseGitDiffStat,
    computeEta, computeBurnRate, summarizeToolUse,
    parsePrdTasksFromContent,
    groupTasksIntoWaves, buildBranchName,
    parallelFallbackReason, shouldRunParallel,
    escapeTags,
} from '../lib/ralph-utils.js';
import { parseArgs } from '../bin/ralph.js';

describe('formatElapsed', () => {
    it('returns 00:00 for falsy input', () => {
        assert.equal(formatElapsed(0), '00:00');
        assert.equal(formatElapsed(null), '00:00');
        assert.equal(formatElapsed(undefined), '00:00');
    });

    it('formats seconds correctly', () => {
        const now = Date.now();
        const startedAt = now - 65_000;
        const result = formatElapsed(startedAt);
        assert.match(result, /^01:0[45]$/);
    });
});

describe('formatCost', () => {
    it('uses 4 decimals for small amounts', () => {
        assert.equal(formatCost(0.0012), '$0.0012');
        assert.equal(formatCost(0.005), '$0.0050');
    });

    it('uses 2 decimals for larger amounts', () => {
        assert.equal(formatCost(1.5), '$1.50');
        assert.equal(formatCost(0.01), '$0.01');
        assert.equal(formatCost(12.345), '$12.35');
    });
});

describe('formatTokens', () => {
    it('formats millions', () => {
        assert.equal(formatTokens(1_500_000), '1.5M');
    });

    it('formats thousands', () => {
        assert.equal(formatTokens(45_200), '45.2k');
    });

    it('returns raw number for small values', () => {
        assert.equal(formatTokens(500), '500');
        assert.equal(formatTokens(0), '0');
    });
});

describe('classifyFileOp', () => {
    it('classifies Read', () => {
        assert.deepEqual(classifyFileOp('Read', { file_path: '/a/b.php' }), { filePath: '/a/b.php', op: 'read' });
    });

    it('classifies Write', () => {
        assert.deepEqual(classifyFileOp('Write', { file_path: '/a/b.php' }), { filePath: '/a/b.php', op: 'write' });
    });

    it('classifies Edit', () => {
        assert.deepEqual(classifyFileOp('Edit', { file_path: '/a/b.php' }), { filePath: '/a/b.php', op: 'edit' });
    });

    it('classifies MultiEdit', () => {
        assert.deepEqual(classifyFileOp('MultiEdit', { file_path: '/a/b.php' }), { filePath: '/a/b.php', op: 'edit' });
    });

    it('returns null for Bash', () => {
        assert.equal(classifyFileOp('Bash', { command: 'ls' }), null);
    });

    it('returns null for unknown tools', () => {
        assert.equal(classifyFileOp('Grep', { pattern: 'foo' }), null);
    });

    it('returns null for null input', () => {
        assert.equal(classifyFileOp('Read', null), null);
    });

    it('returns null when file_path missing', () => {
        assert.equal(classifyFileOp('Read', {}), null);
    });
});

describe('parseTestOutput', () => {
    it('parses Pest compact output', () => {
        assert.deepEqual(
            parseTestOutput('Tests:    42 passed'),
            { passed: 42, failed: 0, skipped: 0 },
        );
    });

    it('parses Pest with failures and skipped', () => {
        assert.deepEqual(
            parseTestOutput('Tests:    40 passed, 2 failed, 1 skipped'),
            { passed: 40, failed: 2, skipped: 1 },
        );
    });

    it('parses Pest with warnings', () => {
        assert.deepEqual(
            parseTestOutput('Tests:    42 passed (2 warnings)'),
            { passed: 42, failed: 0, skipped: 0 },
        );
    });

    it('parses PHPUnit OK format', () => {
        assert.deepEqual(
            parseTestOutput('OK (42 tests, 100 assertions)'),
            { passed: 42, failed: 0, skipped: 0 },
        );
    });

    it('parses PHPUnit failure format', () => {
        assert.deepEqual(
            parseTestOutput('FAILURES!\nTests: 42, Assertions: 100, Failures: 3'),
            { passed: 39, failed: 3, skipped: 0 },
        );
    });

    it('parses PHPUnit with skipped', () => {
        assert.deepEqual(
            parseTestOutput('Tests: 42, Assertions: 100, Failures: 3, Skipped: 2'),
            { passed: 37, failed: 3, skipped: 2 },
        );
    });

    it('returns null for non-test output', () => {
        assert.equal(parseTestOutput('Hello world'), null);
        assert.equal(parseTestOutput(''), null);
        assert.equal(parseTestOutput(null), null);
    });
});

describe('parseGitDiffStat', () => {
    it('parses standard git diff --shortstat', () => {
        assert.deepEqual(
            parseGitDiffStat(' 3 files changed, 45 insertions(+), 12 deletions(-)'),
            { filesChanged: 3, insertions: 45, deletions: 12 },
        );
    });

    it('parses insertions only', () => {
        assert.deepEqual(
            parseGitDiffStat(' 1 file changed, 3 insertions(+)'),
            { filesChanged: 1, insertions: 3, deletions: 0 },
        );
    });

    it('parses deletions only', () => {
        assert.deepEqual(
            parseGitDiffStat(' 2 files changed, 7 deletions(-)'),
            { filesChanged: 2, insertions: 0, deletions: 7 },
        );
    });

    it('returns null for empty input', () => {
        assert.equal(parseGitDiffStat(''), null);
        assert.equal(parseGitDiffStat(null), null);
    });

    it('returns null for non-matching output', () => {
        assert.equal(parseGitDiffStat('not a git output'), null);
    });
});

describe('computeEta', () => {
    it('returns -- when no iterations', () => {
        assert.equal(computeEta([], 5), '--');
    });

    it('returns -- when zero remaining', () => {
        assert.equal(computeEta([60_000], 0), '--');
    });

    it('returns -- when negative remaining', () => {
        assert.equal(computeEta([60_000], -1), '--');
    });

    it('formats minutes for short estimates', () => {
        assert.equal(computeEta([120_000, 180_000], 4), '~10m');
    });

    it('formats hours and minutes for long estimates', () => {
        assert.equal(computeEta([600_000], 10), '~1h 40m');
    });

    it('returns ~0m for very fast iterations', () => {
        assert.equal(computeEta([5_000], 2), '~0m');
    });
});

describe('computeBurnRate', () => {
    it('returns -- when no cost', () => {
        assert.equal(computeBurnRate(0, 60_000, 0), '--');
    });

    it('returns -- when elapsed too short', () => {
        assert.equal(computeBurnRate(1.0, 5_000, 0), '--');
    });

    it('computes rate correctly', () => {
        assert.equal(computeBurnRate(1.50, 600_000, 0), '$0.15/min');
    });

    it('subtracts pause time', () => {
        assert.equal(computeBurnRate(1.50, 600_000, 300_000), '$0.30/min');
    });
});

describe('summarizeToolUse', () => {
    it('summarizes Bash', () => {
        assert.equal(
            summarizeToolUse({ name: 'Bash', input: { description: 'Run tests', command: 'npm test' } }),
            'Bash: Run tests',
        );
    });

    it('summarizes Edit', () => {
        assert.equal(
            summarizeToolUse({ name: 'Edit', input: { file_path: '/a/b.php' } }),
            'Edit: /a/b.php',
        );
    });

    it('summarizes MultiEdit', () => {
        assert.equal(
            summarizeToolUse({ name: 'MultiEdit', input: { file_path: '/a/b.php' } }),
            'MultiEdit: /a/b.php',
        );
    });

    it('summarizes Agent', () => {
        assert.equal(
            summarizeToolUse({ name: 'Agent', input: { description: 'Review code' } }),
            'Agent: Review code',
        );
    });

    it('returns name for unknown tools', () => {
        assert.equal(summarizeToolUse({ name: 'FooBar', input: {} }), 'FooBar');
    });

    it('returns name when no input', () => {
        assert.equal(summarizeToolUse({ name: 'Read', input: null }), 'Read');
    });
});

describe('parsePrdTasksFromContent', () => {
    it('parses tasks with descriptions', () => {
        const content = `# Project

## Tasks

### W1: Foundation

- [ ] **T1: Create model** — Set up migration and factory
- [x] **T2: Add routes** — Wire up the controller

### W2: UI

- [ ] **T3: Build form**

## Other Section
`;

        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 3);

        assert.equal(tasks[0].id, 'T1');
        assert.equal(tasks[0].title, 'Create model');
        assert.equal(tasks[0].description, 'Set up migration and factory');
        assert.equal(tasks[0].done, false);
        assert.equal(tasks[0].group, 'W1');

        assert.equal(tasks[1].id, 'T2');
        assert.equal(tasks[1].done, true);

        assert.equal(tasks[2].id, 'T3');
        assert.equal(tasks[2].title, 'Build form');
        assert.equal(tasks[2].description, '');
        assert.equal(tasks[2].group, 'W2');
    });

    it('returns empty array for no task section', () => {
        assert.deepEqual(parsePrdTasksFromContent('# No tasks here'), []);
    });

    it('stops at next h2', () => {
        const content = `## Tasks

- [ ] **T1: First**

## Notes

- [ ] **T2: Should not match**
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].id, 'T1');
    });

    it('tolerates an annotation between the task id and the colon', () => {
        const content = `## Tasks

### W0: Foundation

- [ ] **T1 (∥): Translations** — Add keys
- [ ] **T2 (∥ lane): Modelo 303** — Build lane
- [ ] **T3 (⛔ blocked): Modelo 347** — Needs upstream
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 3);
        assert.deepEqual(tasks.map(t => t.id), ['T1', 'T2', 'T3']);
        assert.equal(tasks[0].title, 'Translations');
        assert.equal(tasks[0].description, 'Add keys');
        assert.equal(tasks[1].title, 'Modelo 303');
        assert.equal(tasks[2].title, 'Modelo 347');
    });

    it('parses work groups with a lowercase suffix (W3b)', () => {
        const content = `## Tasks

### W3b: Blocked lanes

- [ ] **T9: Something** — body
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].group, 'W3b');
    });
});

describe('escapeTags', () => {
    it('neutralizes blessed tag braces so they render literally', () => {
        assert.equal(escapeTags('lang/{es,ca,en}/x.php'), 'lang/{open}es,ca,en{close}/x.php');
    });

    it('leaves brace-free text untouched', () => {
        assert.equal(escapeTags('Edit: app/Models/User.php'), 'Edit: app/Models/User.php');
    });

    it('coerces nullish input to an empty string', () => {
        assert.equal(escapeTags(null), '');
        assert.equal(escapeTags(undefined), '');
    });

    it('escapes every brace in mixed content', () => {
        assert.equal(escapeTags('a{b}c{d}'), 'a{open}b{close}c{open}d{close}');
    });
});

describe('parsePrdTasksFromContent fallback (generic checkboxes)', () => {
    it('parses a /prd-shaped doc with user-story groups and acceptance criteria', () => {
        const content = `# Feature PRD

## 5. User Stories

Some prose.

## 13. Acceptance Criteria

**US1 — Login flow**
- [ ] Returns HTTP 200 with a token when credentials are valid
- [x] Shows an inline error when credentials are invalid

**US2 — Logout flow**
- [ ] Clears the session cookie
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 3);

        assert.equal(tasks[0].id, 'T1');
        assert.equal(tasks[0].done, false);
        assert.equal(tasks[0].group, 'US1');
        assert.match(tasks[0].title, /Returns HTTP 200/);

        assert.equal(tasks[1].id, 'T2');
        assert.equal(tasks[1].done, true);
        assert.equal(tasks[1].group, 'US1');

        assert.equal(tasks[2].id, 'T3');
        assert.equal(tasks[2].group, 'US2');
    });

    it('parses plain checkboxes with no groups', () => {
        const content = `# Notes

- [ ] First thing
- [x] Second thing done
- [ ] Third thing
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 3);
        assert.deepEqual(tasks.map(t => t.id), ['T1', 'T2', 'T3']);
        assert.deepEqual(tasks.map(t => t.done), [false, true, false]);
        assert.deepEqual(tasks.map(t => t.group), ['', '', '']);
    });

    it('prefers the strict T-id format over the fallback when present', () => {
        const content = `## Tasks

### W1: Setup
- [ ] **T1: Strict task**

## Acceptance Criteria
- [ ] A loose checkbox that must be ignored
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].id, 'T1');
        assert.equal(tasks[0].title, 'Strict task');
        assert.equal(tasks[0].group, 'W1');
    });

    it('resets the group when a heading interrupts checkboxes', () => {
        const content = `**US1 — Story**
- [ ] Under the story

## Sign-off
- [ ] PM approval
`;
        const tasks = parsePrdTasksFromContent(content);
        assert.equal(tasks.length, 2);
        assert.equal(tasks[0].group, 'US1');
        assert.equal(tasks[1].group, '');
    });

    it('truncates long titles and keeps the full text as description', () => {
        const long = 'x'.repeat(120);
        const tasks = parsePrdTasksFromContent(`- [ ] ${long}`);
        assert.equal(tasks.length, 1);
        assert.ok(tasks[0].title.length <= 80);
        assert.match(tasks[0].title, /…$/);
        assert.equal(tasks[0].description, long);
    });

    it('returns empty for a document with headings but no checkboxes', () => {
        const content = `# Title

## Overview
Just prose, no tasks here.
`;
        assert.deepEqual(parsePrdTasksFromContent(content), []);
    });
});

describe('groupTasksIntoWaves', () => {
    const task = (id, group, done = false) => ({ id, title: id, group, done });

    it('returns empty array for no tasks', () => {
        assert.deepEqual(groupTasksIntoWaves([]), []);
    });

    it('groups same-group tasks into one wave and preserves group order', () => {
        const tasks = [
            task('T1', 'W1'), task('T2', 'W1'),
            task('T3', 'W2'),
        ];
        const waves = groupTasksIntoWaves(tasks);
        assert.equal(waves.length, 2);
        assert.equal(waves[0].group, 'W1');
        assert.deepEqual(waves[0].tasks.map(t => t.id), ['T1', 'T2']);
        assert.equal(waves[1].group, 'W2');
        assert.deepEqual(waves[1].tasks.map(t => t.id), ['T3']);
    });

    it('drops done tasks before forming waves', () => {
        const tasks = [task('T1', 'W1', true), task('T2', 'W1'), task('T3', 'W2', true)];
        const waves = groupTasksIntoWaves(tasks);
        assert.equal(waves.length, 1);
        assert.deepEqual(waves[0].tasks.map(t => t.id), ['T2']);
    });

    it('chunks an oversized group into back-to-back sub-waves of the same group', () => {
        const tasks = Array.from({ length: 7 }, (_, n) => task(`T${n + 1}`, 'W1'));
        const waves = groupTasksIntoWaves(tasks, 3);
        assert.equal(waves.length, 3);
        assert.deepEqual(waves.map(w => w.tasks.length), [3, 3, 1]);
        assert.ok(waves.every(w => w.group === 'W1'));
    });

    it('makes each ungrouped task its own singleton wave', () => {
        const tasks = [task('T1', ''), task('T2', '')];
        const waves = groupTasksIntoWaves(tasks);
        assert.equal(waves.length, 2);
        assert.ok(waves.every(w => w.tasks.length === 1));
    });

    it('does not merge non-adjacent same-group tasks across an ungrouped one', () => {
        const tasks = [task('T1', 'W1'), task('T2', ''), task('T3', 'W1')];
        const waves = groupTasksIntoWaves(tasks);
        assert.deepEqual(waves.map(w => w.tasks.map(t => t.id)), [['T1'], ['T2'], ['T3']]);
    });
});

describe('parallelFallbackReason / shouldRunParallel', () => {
    const ok = { requested: true, isGit: true, clean: true, taskCount: 3 };

    it('returns null (runs parallel) when all preconditions hold', () => {
        assert.equal(parallelFallbackReason(ok), null);
        assert.equal(shouldRunParallel(ok), true);
    });

    it('falls back when parallel was not requested', () => {
        const r = parallelFallbackReason({ ...ok, requested: false });
        assert.match(r, /sequential requested/);
        assert.equal(shouldRunParallel({ ...ok, requested: false }), false);
    });

    it('falls back when not a git repo', () => {
        assert.match(parallelFallbackReason({ ...ok, isGit: false }), /not a git repo/);
        assert.equal(shouldRunParallel({ ...ok, isGit: false }), false);
    });

    it('falls back when the working tree is dirty', () => {
        assert.match(parallelFallbackReason({ ...ok, clean: false }), /dirty/);
        assert.equal(shouldRunParallel({ ...ok, clean: false }), false);
    });

    it('falls back when there are no parseable tasks (the dangerous no-op case)', () => {
        assert.match(parallelFallbackReason({ ...ok, taskCount: 0 }), /no parseable/);
        assert.equal(shouldRunParallel({ ...ok, taskCount: 0 }), false);
    });

    it('checks git before tree-cleanliness when both fail', () => {
        // not-git takes priority so the message points at the root cause.
        assert.match(parallelFallbackReason({ ...ok, isGit: false, clean: false }), /not a git repo/);
    });
});

describe('parseArgs (mode defaults)', () => {
    let fixture, prevCwd;

    before(() => {
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-args-'));
        fs.writeFileSync(path.join(fixture, 'PROMPT.md'), 'Work on @PROJECT.md\n');
        fs.writeFileSync(path.join(fixture, 'PRD.md'), '# PRD\n');
        prevCwd = process.cwd();
        process.chdir(fixture);
    });

    after(() => {
        process.chdir(prevCwd);
        fs.rmSync(fixture, { recursive: true, force: true });
    });

    const parse = (...flags) => parseArgs(['node', 'ralph', 'PRD.md', ...flags]);

    it('defaults to parallel mode', () => {
        assert.equal(parse().parallel, true);
    });

    it('--sequential forces sequential', () => {
        assert.equal(parse('--sequential').parallel, false);
    });

    it('--no-parallel is an alias for --sequential', () => {
        assert.equal(parse('--no-parallel').parallel, false);
    });

    it('--parallel is an accepted no-op (stays parallel)', () => {
        assert.equal(parse('--parallel').parallel, true);
    });

    it('--max-parallel does not override --sequential, regardless of order', () => {
        assert.equal(parse('--sequential', '--max-parallel', '4').parallel, false);
        assert.equal(parse('--max-parallel', '4', '--sequential').parallel, false);
    });
});

describe('buildBranchName', () => {
    it('slugifies the title', () => {
        assert.equal(buildBranchName('T1', 'Create the User model'), 'ralph/T1-create-the-user-model');
    });

    it('collapses non-alphanumerics and trims dashes', () => {
        assert.equal(buildBranchName('T2', '  Add /routes & wiring!! '), 'ralph/T2-add-routes-wiring');
    });

    it('falls back to id-only for an empty or symbol-only title', () => {
        assert.equal(buildBranchName('T3', ''), 'ralph/T3');
        assert.equal(buildBranchName('T4', '***'), 'ralph/T4');
    });

    it('caps slug length and uses only the safe charset', () => {
        const name = buildBranchName('T5', 'x'.repeat(100));
        assert.match(name, /^ralph\/T5-[a-z0-9-]+$/);
        assert.ok(name.length <= 'ralph/T5-'.length + 40);
    });
});

// ─── CLI Command Tests ──────────────────────────────────────────────────────

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ralph.js');
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-'));
fs.writeFileSync(path.join(FIXTURE, 'PROMPT.md'), 'Work on @PROJECT.md\n');

function run(...args) {
    try {
        const stdout = execFileSync('node', [BIN, ...args], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: FIXTURE,
        });
        return { code: 0, stdout, stderr: '' };
    } catch (err) {
        return {
            code: err.status,
            stdout: err.stdout || '',
            stderr: err.stderr || '',
        };
    }
}

describe('ralph CLI', () => {
    it('prints help with --help and exits 0', () => {
        const { code, stdout } = run('--help');
        assert.equal(code, 0);
        assert.match(stdout, /Usage: ralph/);
        assert.match(stdout, /--budget/);
        assert.match(stdout, /prd-file/);
        assert.match(stdout, /\binit\b/);
    });

    it('prints help with -h and exits 0', () => {
        const { code, stdout } = run('-h');
        assert.equal(code, 0);
        assert.match(stdout, /Usage:/);
    });

    it('errors on missing prd-file', () => {
        const { code, stderr } = run();
        assert.equal(code, 2);
        assert.match(stderr, /missing <prd-file>/);
    });

    it('errors on nonexistent prd file', () => {
        const { code, stderr } = run('nonexistent-file-abc123.md');
        assert.equal(code, 2);
        assert.match(stderr, /PRD file not found/);
    });

    it('errors on invalid iteration count', () => {
        const { code, stderr } = run('PROMPT.md', 'notanumber');
        assert.equal(code, 2);
        assert.match(stderr, /positive integer/);
    });

    it('errors on zero iterations', () => {
        const { code, stderr } = run('PROMPT.md', '0');
        assert.equal(code, 2);
        assert.match(stderr, /positive integer/);
    });

    it('errors on --budget without value', () => {
        const { code, stderr } = run('--budget');
        assert.equal(code, 2);
        assert.match(stderr, /--budget must be a positive number/);
    });

    it('errors on --budget with negative value', () => {
        const { code, stderr } = run('--budget', '-5', 'PROMPT.md');
        assert.equal(code, 2);
        assert.match(stderr, /--budget must be a positive number/);
    });

    it('errors on --budget with zero', () => {
        const { code, stderr } = run('--budget', '0', 'PROMPT.md');
        assert.equal(code, 2);
        assert.match(stderr, /--budget must be a positive number/);
    });

    it('requires TTY for valid args (exits 2 in test pipe)', () => {
        const { code, stderr } = run('PROMPT.md', '5');
        assert.equal(code, 2);
        assert.match(stderr, /requires a TTY/);
    });

    it('accepts --budget with valid args (still fails on TTY)', () => {
        const { code, stderr } = run('PROMPT.md', '5', '--budget', '10.00');
        assert.equal(code, 2);
        assert.match(stderr, /requires a TTY/);
    });

    it('documents --sequential and --max-parallel in help', () => {
        const { code, stdout } = run('--help');
        assert.equal(code, 0);
        assert.match(stdout, /--sequential/);
        assert.match(stdout, /--max-parallel/);
        assert.match(stdout, /default/i);
    });

    it('accepts --parallel as a no-op alias (still fails on TTY)', () => {
        const { code, stderr } = run('PROMPT.md', '--parallel');
        assert.equal(code, 2);
        assert.match(stderr, /requires a TTY/);
    });

    it('accepts --sequential with valid args (still fails on TTY)', () => {
        const { code, stderr } = run('PROMPT.md', '--sequential');
        assert.equal(code, 2);
        assert.match(stderr, /requires a TTY/);
    });

    it('errors on --max-parallel with a non-positive value', () => {
        const { code, stderr } = run('PROMPT.md', '--max-parallel', '0');
        assert.equal(code, 2);
        assert.match(stderr, /--max-parallel must be a positive integer/);
    });
});

describe('ralph init', () => {
    function runInitIn(cwd, ...args) {
        try {
            const stdout = execFileSync('node', [BIN, ...args], {
                encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], cwd,
            });
            return { code: 0, stdout };
        } catch (err) {
            return { code: err.status, stdout: err.stdout || '' };
        }
    }

    it('scaffolds PROMPT.md and the /prd command, and does not overwrite on re-run', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-init-'));
        const prompt = path.join(dir, 'PROMPT.md');
        const prd = path.join(dir, '.claude', 'commands', 'prd.md');

        const first = runInitIn(dir, 'init');
        assert.equal(first.code, 0);
        assert.ok(fs.existsSync(prompt), 'PROMPT.md created');
        assert.ok(fs.existsSync(prd), '.claude/commands/prd.md created');
        assert.match(fs.readFileSync(prd, 'utf8'), /^## Tasks$/m);

        fs.writeFileSync(prompt, 'CUSTOM');
        const second = runInitIn(dir, 'init');
        assert.equal(second.code, 0);
        assert.match(second.stdout, /skipped \(exists\)/);
        assert.equal(fs.readFileSync(prompt, 'utf8'), 'CUSTOM', 'existing file preserved');
    });

    it('update overwrites existing PROMPT.md and the /prd command', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-update-'));
        const prompt = path.join(dir, 'PROMPT.md');
        const prd = path.join(dir, '.claude', 'commands', 'prd.md');

        assert.equal(runInitIn(dir, 'init').code, 0);
        fs.writeFileSync(prompt, 'STALE');
        fs.writeFileSync(prd, 'STALE');

        const upd = runInitIn(dir, 'update');
        assert.equal(upd.code, 0);
        assert.match(upd.stdout, /updated:/);
        assert.notEqual(fs.readFileSync(prompt, 'utf8'), 'STALE', 'PROMPT.md refreshed');
        assert.match(fs.readFileSync(prd, 'utf8'), /^## Tasks$/m, '/prd command refreshed');
    });

    it('init --force also overwrites existing assets', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-force-'));
        const prompt = path.join(dir, 'PROMPT.md');

        assert.equal(runInitIn(dir, 'init').code, 0);
        fs.writeFileSync(prompt, 'STALE');

        const forced = runInitIn(dir, 'init', '--force');
        assert.equal(forced.code, 0);
        assert.match(forced.stdout, /updated:/);
        assert.notEqual(fs.readFileSync(prompt, 'utf8'), 'STALE', 'PROMPT.md refreshed');
    });
});
