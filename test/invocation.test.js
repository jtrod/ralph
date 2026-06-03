import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RALPH_BIN = fileURLToPath(new URL('../bin/ralph.js', import.meta.url));

// Regression: when ralph is launched through a symlink (npm bin, npx, npm link),
// argv[1] is the symlink path but import.meta.url is the realpath. A naive
// path.resolve() comparison never matches, so main() is skipped and the process
// exits 0 with no output ("nothing happens"). main() must still run: with no TTY
// it should reach the TTY guard and exit 2 with a clear message.
describe('symlinked invocation runs main()', () => {
    let tmpDir;
    let linkPath;
    let prdPath;

    before(() => {
    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-inv-'));
        linkPath = path.join(tmpDir, 'link-ralph.js');
        fs.symlinkSync(RALPH_BIN, linkPath, 'file');
        prdPath = path.join(tmpDir, 'PRD.md');
        fs.writeFileSync(prdPath, '# PRD\n');
        // parseArgs requires PROMPT.md in cwd; create it so arg validation passes
        // and execution reaches the TTY guard, which is what we want to assert.
        fs.writeFileSync(path.join(tmpDir, 'PROMPT.md'), '# Agent\n');
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reaches the TTY guard (exit 2) instead of exiting 0 silently', () => {
        // stdio 'pipe' => not a TTY, so a working main() hits the TTY guard.
        const res = spawnSync(process.execPath, [linkPath, prdPath], {
            cwd: tmpDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert.equal(res.status, 2, 'main() did not run (exited 0 silently)');
        assert.match(res.stderr, /requires a TTY/);
    });
});
