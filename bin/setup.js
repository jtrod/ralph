#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

function getProjectRoot() {
    const cwd = process.cwd();
    if (cwd.includes('node_modules')) {
        return path.resolve(cwd, '..', '..');
    }
    return cwd;
}

function copyTemplate(templateName, destPath) {
    try {
        if (fs.existsSync(destPath)) {
            return;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(path.join(TEMPLATES_DIR, templateName), destPath);
    } catch (err) {
        // Silent fail - postinstall should not break npm install
    }
}

try {
    const projectRoot = getProjectRoot();
    copyTemplate('PROMPT.md', path.resolve(projectRoot, 'PROMPT.md'));
    copyTemplate('prd.md', path.resolve(projectRoot, '.claude', 'commands', 'prd.md'));
} catch (err) {
    // Silent fail
}
