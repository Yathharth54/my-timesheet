import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig, loadRepos, saveDraft, emptyDraft } from '../src/lib/store.js';

const cli = (args: string[], cwd = process.cwd()) =>
  spawnSync('node', [path.resolve('dist/cli/index.js'), ...args], { cwd, env: { ...process.env }, encoding: 'utf8' });

describe('timesheet CLI', () => {
  beforeAll(() => { execSync('npm run build', { stdio: 'ignore' }); });
  beforeEach(() => { tmpHome(); });

  it('prints help and fails clearly before init', () => {
    expect(cli(['--help']).stdout).toMatch(/timesheet init/);
    const r = cli(['status']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/timesheet init/);
  });

  it('repo saves a classification for a folder with spaces and validates projects', () => {
    saveConfig(testConfig());
    const dir = path.join(tmpDir(), 'my side project');
    fs.mkdirSync(dir);
    expect(cli(['repo', 'work', '--path', dir, '--project', 'Nope']).stderr).toMatch(/Unknown project "Nope"/);
    expect(cli(['repo', 'work', '--path', dir, '--project', 'Boxsy']).status).toBe(0);
    expect(loadRepos()[dir]).toMatchObject({ class: 'work', project: 'Boxsy' });
    expect(cli(['repo', 'personal', '--path', dir]).status).toBe(0);
    expect(loadRepos()[dir]).toMatchObject({ class: 'personal' });
  });

  it('status prints the week summary', () => {
    saveConfig(testConfig());
    saveDraft(emptyDraft('2026-W41'));
    expect(cli(['status', '--week', '2026-W41']).stdout).toMatch(/2026-W41 · 0\.0h · 0 items · not pushed/);
  });
});
