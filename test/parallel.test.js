import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePrdTasksFromContent } from '../lib/ralph-utils.js';
import { runWaves, STATE } from '../bin/ralph.js';

// A no-op UI: every method is a function that does nothing. runWaves/runAgent
// only ever *call* UI methods, never read from them.
const stubUi = new Proxy({}, { get: () => () => {} });

// Write a fake `claude` onto PATH. It parses the task id from the injected
// prompt, creates that task's file in cwd (the worktree), and emits a minimal
// stream-json result event. With FAKE_SHARED=1 every task writes the SAME file
// to force a merge conflict.
function installFakeClaude(homeDir, { shared = false } = {}) {
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const m = prompt.match(/\\n\\s+(T\\w+):/);
const id = m ? m[1] : 'TX';
const file = ${shared ? "'shared.txt'" : '`${id}.txt`'};
require('fs').writeFileSync(file, 'work for ' + id + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
process.exit(0);
`;
    const p = path.join(homeDir, 'claude');
    fs.writeFileSync(p, script, { mode: 0o755 });
}

function initRepo(prd, { testScript = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-wave-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    git('init', '-q');
    git('config', 'user.email', 't@t.com');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'PROMPT.md'), 'Work on @PROJECT.md\n');
    fs.writeFileSync(path.join(dir, 'prd.md'), prd);
    if (testScript) {
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: testScript } }, null, 2),
        );
    }
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
}

function prepState(dir) {
    STATE.children.clear();
    STATE.wave = null;
    STATE.canceled = false;
    STATE.skipped = false;
    STATE.paused = false;
    STATE.budget = null;
    STATE.totalCost = 0;
    STATE.parallel = true;
    STATE.maxParallel = 6;
    STATE.prdPath = path.join(dir, 'prd.md');
    STATE.tasks = parsePrdTasksFromContent(fs.readFileSync(STATE.prdPath, 'utf8'));
}

describe('runWaves (parallel scheduler)', () => {
    let savedCwd;
    let homeDir;

    before(() => {
        savedCwd = process.cwd();
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-bin-'));
        process.env.PATH = `${homeDir}${path.delimiter}${process.env.PATH}`;
    });

    after(() => {
        process.chdir(savedCwd);
    });

    it('refuses a non-git directory', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-nogit-'));
        fs.writeFileSync(path.join(dir, 'prd.md'), '## Tasks\n- [ ] **T1: x**\n');
        prepState(dir);
        process.chdir(dir);
        const result = await runWaves(STATE.prdPath, stubUi);
        assert.equal(result.reason, 'not-git');
    });

    it('refuses a dirty working tree', async () => {
        const dir = initRepo('## Tasks\n\n### W1: A\n- [ ] **T1: alpha**\n');
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
        prepState(dir);
        process.chdir(dir);
        const result = await runWaves(STATE.prdPath, stubUi);
        assert.equal(result.reason, 'dirty-tree');
    });

    it('runs a multi-task wave concurrently in worktrees, merges, checks off, and cleans up', async () => {
        installFakeClaude(homeDir, { shared: false });
        const dir = initRepo([
            '# Demo', '', '## Tasks', '',
            '### W1: Foundation',
            '- [ ] **T1: Alpha module**',
            '- [ ] **T2: Beta module**',
            '', '### W2: Polish',
            '- [ ] **T3: Gamma module**', '',
        ].join('\n'));
        prepState(dir);
        process.chdir(dir);

        const result = await runWaves(STATE.prdPath, stubUi);
        const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

        assert.equal(result.reason, 'complete');

        // All checkboxes flipped to [x] by Ralph (not the agents).
        const prd = fs.readFileSync(path.join(dir, 'prd.md'), 'utf8');
        assert.equal((prd.match(/- \[x\]/g) || []).length, 3, 'all three tasks checked off');
        assert.ok(!/- \[ \]/.test(prd), 'no unchecked tasks remain');

        // Each task's file was produced and committed on the base branch.
        for (const f of ['T1.txt', 'T2.txt', 'T3.txt']) {
            assert.ok(fs.existsSync(path.join(dir, f)), `${f} present on base`);
        }

        // PROGRESS.md authored by Ralph.
        const progress = fs.readFileSync(path.join(dir, 'PROGRESS.md'), 'utf8');
        for (const id of ['T1', 'T2', 'T3']) assert.match(progress, new RegExp(id));

        // The two-task wave produced merge commits; no worktrees/branches leaked.
        assert.match(git('log', '--oneline'), /merge T1|merge T2/);
        assert.equal(git('worktree', 'list').trim().split('\n').length, 1, 'only the main worktree remains');
        const branches = git('branch').replace(/[*\s]/g, '').split('\n').filter(Boolean);
        assert.deepEqual(branches, ['main'], 'no ralph/* branches leaked');
    });

    it('runs the post-merge test gate and completes when tests pass', async () => {
        installFakeClaude(homeDir, { shared: false });
        const dir = initRepo([
            '## Tasks', '',
            '### W1: A',
            '- [ ] **T1: alpha**',
            '- [ ] **T2: beta**', '',
        ].join('\n'), { testScript: 'node -e "process.exit(0)"' });
        prepState(dir);
        process.chdir(dir);

        const result = await runWaves(STATE.prdPath, stubUi);
        assert.equal(result.reason, 'complete');
        const prd = fs.readFileSync(path.join(dir, 'prd.md'), 'utf8');
        assert.equal((prd.match(/- \[x\]/g) || []).length, 2);
    });

    it('rolls back and re-queues a task that fails the post-merge test gate, preserving earlier merges', async () => {
        installFakeClaude(homeDir, { shared: false });
        // Test fails whenever T2.txt exists, so T1 passes the gate but T2 never can.
        const dir = initRepo([
            '## Tasks', '',
            '### W1: A',
            '- [ ] **T1: alpha**',
            '- [ ] **T2: beta**', '',
        ].join('\n'), { testScript: 'node -e "process.exit(require(\'fs\').existsSync(\'T2.txt\')?1:0)"' });
        prepState(dir);
        process.chdir(dir);

        const result = await runWaves(STATE.prdPath, stubUi);
        const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

        // T2 cannot pass the gate even on solo retry → fail loud, never silently dropped.
        assert.equal(result.reason, 'task-failed');
        assert.equal(result.taskId, 'T2');

        const prd = fs.readFileSync(path.join(dir, 'prd.md'), 'utf8');
        // T1's successful merge survived T2's rollback: T1 checked off + present, T2 not.
        assert.match(prd, /- \[x\] \*\*T1:/);
        assert.match(prd, /- \[ \] \*\*T2:/);
        assert.ok(fs.existsSync(path.join(dir, 'T1.txt')), 'T1 work preserved through T2 rollback');
        assert.ok(!fs.existsSync(path.join(dir, 'T2.txt')), 'T2 work rolled back off base');
        assert.equal(git('worktree', 'list').trim().split('\n').length, 1, 'no leaked worktrees');
        const branches = git('branch').replace(/[*\s]/g, '').split('\n').filter(Boolean);
        assert.deepEqual(branches, ['main']);
    });

    it('re-queues a conflicting task to run solo and still completes', async () => {
        installFakeClaude(homeDir, { shared: true });
        const dir = initRepo([
            '## Tasks', '',
            '### W1: Conflict',
            '- [ ] **T1: first writer**',
            '- [ ] **T2: second writer**', '',
        ].join('\n'));
        prepState(dir);
        process.chdir(dir);

        const result = await runWaves(STATE.prdPath, stubUi);
        const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

        assert.equal(result.reason, 'complete');
        const prd = fs.readFileSync(path.join(dir, 'prd.md'), 'utf8');
        assert.equal((prd.match(/- \[x\]/g) || []).length, 2, 'both tasks eventually checked off');
        assert.ok(fs.existsSync(path.join(dir, 'shared.txt')));
        // No leaked worktrees/branches after the requeue path.
        assert.equal(git('worktree', 'list').trim().split('\n').length, 1);
    });
});
