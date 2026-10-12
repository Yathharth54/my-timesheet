import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig, loadRepos, saveDraft, emptyDraft } from '../src/lib/store.js';
import { acquireWeekLock } from '../src/lib/lock.js';

const cli = (args: string[], cwd = process.cwd()) =>
  spawnSync('node', [path.resolve('dist/cli/index.js'), ...args], { cwd, env: { ...process.env }, encoding: 'utf8' });

describe('timesheet CLI', () => {
  beforeAll(() => { execSync('npm run build', { stdio: 'ignore' }); }, 120_000); // a full tsc build can pass vitest's 10 s hook default on a busy machine
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

  it('push refuses to run while the week is locked', () => {
    saveConfig(testConfig());
    saveDraft(emptyDraft('2026-W41'));
    const release = acquireWeekLock('2026-W41');
    try {
      const r = cli(['push', '--week', '2026-W41']);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Week 2026-W41 is busy/);
    } finally { release(); }
  });

  it('show lists issues with ids; edit applies ops and holds pushed deletes back without --remote', async () => {
    const { makeDraft, makeItem } = await import('./helpers.js');
    const { loadDraft } = await import('../src/lib/store.js');
    saveConfig(testConfig());
    saveDraft(makeDraft({ items: [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'p', title: 'Shipped', linear: { uuid: 'u', identifier: 'THE-7', url: null, created: true } })] }));
    const shown = JSON.parse(cli(['show', '--week', '2026-W41']).stdout);
    expect(shown.issues.map((i: any) => [i.id, i.inLinear])).toEqual([['a', false], ['b', false], ['p', 'THE-7']]);
    const ops = path.join(tmpDir(), 'ops.json');
    fs.writeFileSync(ops, JSON.stringify({ ops: [{ op: 'set', ids: ['a', 'b'], project: 'Dev - Internal' }, { op: 'delete', ids: ['p'] }] }));
    const r = cli(['edit', '--week', '2026-W41', '--ops', ops]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Move 2 issues to Dev - Internal/);
    expect(r.stdout).toMatch(/Not deleted yet[\s\S]*THE-7\s+Shipped[\s\S]*--remote/);
    const d = loadDraft('2026-W41')!;
    expect(d.items.map(i => [i.project, i.deleted])).toEqual([['Dev - Internal', false], ['Dev - Internal', false], ['Boxsy', false]]);
    fs.writeFileSync(ops, '[{"op":"set","ids":["zz"],"project":"Boxsy"}]');
    const bad = cli(['edit', '--week', '2026-W41', '--ops', ops]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/No issue with id zz/);
  });
});
