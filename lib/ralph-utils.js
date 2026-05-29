export const TASK_LINE_RE = /^-\s+\[([ xX])\]\s+\*\*(T[A-Z0-9]+):\s+(.+?)\*\*/;
export const WORK_GROUP_RE = /^###\s+(W[A-Z0-9]+):\s+(.+?)(?:\s+\(.*\))?$/;

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
