// Task lines tolerate an optional annotation between the ID and the colon, e.g.
// `**T1 (∥): Translations**` or `**T11 (⛔ blocked): …**` — the `/prd` template
// encourages such markers. The annotation is consumed but not captured; groups
// stay [1]=checkbox, [2]=id, [3]=title.
export const TASK_LINE_RE = /^-\s+\[([ xX])\]\s+\*\*(T[A-Z0-9]+)(?:\s+\([^)]*\))?:\s+(.+?)\*\*/;
// Work-group suffix allows lowercase (e.g. `### W3b:` alongside `### W4:`).
export const WORK_GROUP_RE = /^###\s+(W[A-Za-z0-9]+):\s+(.+?)(?:\s+\(.*\))?$/;

// Escape PRD/tool-derived text so blessed does not interpret `{...}` as markup
// tags. Mirrors blessed.escape: `{`/`}` become the literal-brace tokens
// `{open}`/`{close}`. Without this, content like `lang/{es,ca,en}/x.php` reaching
// a `tags: true` widget makes blessed's tag parser dereference a null attribute
// and crash the entire TUI (`Cannot read properties of null (reading 'slice')`).
export function escapeTags(s) {
    return String(s ?? '').replace(/[{}]/g, ch => (ch === '{' ? '{open}' : '{close}'));
}

export function formatElapsed(startedAt) {
    if (!startedAt) return '00:00';
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

export function formatCost(usd) {
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

export function classifyFileOp(toolName, input) {
    if (!input) return null;
    switch (toolName) {
        case 'Read':
            return input.file_path ? { filePath: input.file_path, op: 'read' } : null;
        case 'Write':
            return input.file_path ? { filePath: input.file_path, op: 'write' } : null;
        case 'Edit':
        case 'MultiEdit':
            return input.file_path ? { filePath: input.file_path, op: 'edit' } : null;
        default:
            return null;
    }
}

export function parseTestOutput(text) {
    if (!text) return null;

    const pestMatch = text.match(/^.*Tests:\s+(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+skipped)?/im);
    if (pestMatch) {
        return {
            passed: parseInt(pestMatch[1], 10),
            failed: pestMatch[2] ? parseInt(pestMatch[2], 10) : 0,
            skipped: pestMatch[3] ? parseInt(pestMatch[3], 10) : 0,
        };
    }

    const phpunitOk = text.match(/^OK\s+\((\d+)\s+tests?,\s+\d+\s+assertions?\)/im);
    if (phpunitOk) {
        return {
            passed: parseInt(phpunitOk[1], 10),
            failed: 0,
            skipped: 0,
        };
    }

    const phpunitFail = text.match(/^Tests:\s+(\d+).*?Failures:\s+(\d+)(?:.*?Skipped:\s+(\d+))?/im);
    if (phpunitFail) {
        const total = parseInt(phpunitFail[1], 10);
        const failed = parseInt(phpunitFail[2], 10);
        const skipped = phpunitFail[3] ? parseInt(phpunitFail[3], 10) : 0;
        return { passed: total - failed - skipped, failed, skipped };
    }

    return null;
}

export function parseGitDiffStat(output) {
    if (!output) return null;
    const match = output.match(
        /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
    );
    if (!match) return null;
    return {
        filesChanged: parseInt(match[1], 10),
        insertions: match[2] ? parseInt(match[2], 10) : 0,
        deletions: match[3] ? parseInt(match[3], 10) : 0,
    };
}

export function computeEta(iterDurationsMs, remainingCount) {
    if (iterDurationsMs.length === 0 || remainingCount <= 0) return '--';
    const avg = iterDurationsMs.reduce((a, b) => a + b, 0) / iterDurationsMs.length;
    const mins = Math.round((avg * remainingCount) / 60_000);
    if (mins < 1) return '~0m';
    if (mins < 60) return `~${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `~${hours}h ${String(rem).padStart(2, '0')}m` : `~${hours}h`;
}

export function computeBurnRate(totalCost, elapsedMs, pausedMs) {
    const effectiveMs = elapsedMs - (pausedMs || 0);
    if (effectiveMs < 10_000 || totalCost === 0) return '--';
    const rate = totalCost / (effectiveMs / 60_000);
    return `$${rate.toFixed(2)}/min`;
}

export function summarizeToolUse(toolUse) {
    const { name, input } = toolUse;
    if (!input) return name;

    switch (name) {
        case 'Bash':
            return `Bash: ${(input.description || input.command || '').slice(0, 80)}`;
        case 'Edit':
            return `Edit: ${input.file_path || ''}`;
        case 'MultiEdit':
            return `MultiEdit: ${input.file_path || ''}`;
        case 'Write':
            return `Write: ${input.file_path || ''}`;
        case 'Read':
            return `Read: ${input.file_path || ''}`;
        case 'Grep':
            return `Grep: ${input.pattern || ''} in ${input.path || '.'}`;
        case 'Glob':
            return `Glob: ${input.pattern || ''}`;
        case 'Agent':
        case 'Task':
            return `${name}: ${(input.description || input.prompt || '').slice(0, 60)}`;
        default:
            return name;
    }
}

export const CHECKBOX_LINE_RE = /^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/;
export const USER_STORY_GROUP_RE = /^\*\*(US[A-Z0-9]+)\b.*?\*\*\s*$/;
const FALLBACK_TITLE_MAX = 80;

export function parsePrdTasksFromContent(content) {
    const strict = parseStrictTasks(content);

    return strict.length > 0 ? strict : parseFallbackTasks(content);
}

function parseStrictTasks(content) {
    const lines = content.split('\n');
    const tasks = [];
    let inTaskSection = false;
    let currentGroup = '';

    for (const line of lines) {
        if (/^##\s+.*tasks/i.test(line)) {
            inTaskSection = true;
            continue;
        }
        if (inTaskSection && /^##\s+/.test(line) && !/^###/.test(line)) {
            break;
        }
        if (!inTaskSection) {
            continue;
        }

        const groupMatch = line.match(WORK_GROUP_RE);
        if (groupMatch) {
            currentGroup = groupMatch[1];
            continue;
        }

        const taskMatch = line.match(TASK_LINE_RE);
        if (taskMatch) {
            const fullTitle = taskMatch[3];
            const descMatch = line.match(/\*\*\s*—\s*(.+)$/);

            tasks.push({
                id: taskMatch[2],
                title: fullTitle.replace(/\s*—.*$/, '').trim(),
                description: descMatch ? descMatch[1].trim() : '',
                done: taskMatch[1] !== ' ',
                group: currentGroup,
            });
        }
    }

    return tasks;
}

export const DEFAULT_WAVE_CAP = 6;

// Decide whether a requested parallel run can actually proceed, or must fall
// back to the sequential loop. Parallel needs a git repo, a clean working tree,
// and at least one parseable `### Wn`/checkbox task — otherwise `runWaves`
// would either hard-error (not-git/dirty-tree) or, with zero tasks, instantly
// report "complete" having done nothing. Returns the human-readable reason a
// fallback is required, or null when parallel can run. Pure so it can be unit
// tested; `main()` feeds it the results of isGitRepo/isWorkingTreeClean.
export function parallelFallbackReason({ requested, isGit, clean, taskCount }) {
    if (!requested) return 'sequential requested';
    if (!isGit) return 'not a git repo';
    if (!clean) return 'working tree is dirty';
    if (!(taskCount > 0)) return 'no parseable ### Wn tasks in the PRD';
    return null;
}

// Convenience boolean wrapper around parallelFallbackReason.
export function shouldRunParallel(opts) {
    return parallelFallbackReason(opts) === null;
}

// Partition not-yet-done tasks into sequential waves. Tasks sharing a `### Wn`
// group run together in one wave; groups run in document order. An ungrouped
// task (group === '') is its own singleton wave so a plain checkbox PRD keeps
// today's strictly-sequential behavior. A group larger than `cap` is split into
// back-to-back sub-waves of the same group (wave size = min(groupSize, cap)).
export function groupTasksIntoWaves(tasks, cap = DEFAULT_WAVE_CAP) {
    const limit = cap > 0 ? cap : DEFAULT_WAVE_CAP;
    const pending = (tasks || []).filter(t => !t.done);
    const waves = [];
    let i = 0;

    while (i < pending.length) {
        const task = pending[i];

        if (!task.group) {
            waves.push({ group: '', tasks: [task] });
            i += 1;
            continue;
        }

        const groupTasks = [];
        const group = task.group;
        while (i < pending.length && pending[i].group === group) {
            groupTasks.push(pending[i]);
            i += 1;
        }
        for (let j = 0; j < groupTasks.length; j += limit) {
            waves.push({ group, tasks: groupTasks.slice(j, j + limit) });
        }
    }

    return waves;
}

// Build a git branch name for a task's isolated worktree: ralph/<id>-<slug>.
export function buildBranchName(taskId, title = '') {
    const slug = String(title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
    return slug ? `ralph/${taskId}-${slug}` : `ralph/${taskId}`;
}

function parseFallbackTasks(content) {
    const lines = content.split('\n');
    const tasks = [];
    let currentGroup = '';

    for (const line of lines) {
        const groupMatch = line.match(USER_STORY_GROUP_RE);
        if (groupMatch) {
            currentGroup = groupMatch[1];
            continue;
        }
        if (/^#{1,6}\s/.test(line)) {
            currentGroup = '';
            continue;
        }

        const checkboxMatch = line.match(CHECKBOX_LINE_RE);
        if (checkboxMatch) {
            const text = checkboxMatch[2].trim();
            const truncated = text.length > FALLBACK_TITLE_MAX;

            tasks.push({
                id: `T${tasks.length + 1}`,
                title: truncated ? `${text.slice(0, FALLBACK_TITLE_MAX - 1)}…` : text,
                description: truncated ? text : '',
                done: checkboxMatch[1] !== ' ',
                group: currentGroup,
            });
        }
    }

    return tasks;
}
