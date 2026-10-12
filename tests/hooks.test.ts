import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome, testConfig } from './helpers.js';
import { saveConfig, loadRepos, readJsonl, saveRepos, saveDraft, emptyDraft, appendLine } from '../src/lib/store.js';
import { paths } from '../src/lib/paths.js';
import type { GitProbe } from '../src/lib/repo.js';
import { sessionStartContext } from '../src/hooks/session-start.js';
import { recordTurn } from '../src/hooks/stop.js';

const now = new Date('2026-10-06T10:00:00Z');
const probe = (root: string, urls: string[]): GitProbe => ({ root: () => root, remoteUrls: () => urls });
const turn = { session_id: 's1', transcript_path: '/t/s1.jsonl' };

describe('hooks', () => {
  beforeEach(() => { tmpHome(); delete process.env.TIMESHEET_DISABLE_HOOKS; });

  it('session start brings the copied /timesheet files up to the installed version', async () => {
    const path = await import('node:path');
    const { tmpDir } = await import('./helpers.js');
    const { installSkillFiles } = await import('../src/lib/install.js');
    saveConfig(testConfig());
    saveRepos({ '/r': { class: 'personal' } });
    const pkg = tmpDir();
    fs.mkdirSync(path.join(pkg, 'skill', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'skill', 'SKILL.md'), 'v1');
    fs.writeFileSync(path.join(pkg, 'skill', 'commands', 'timesheet.md'), 'v1');
    const [skill, cmd] = installSkillFiles(pkg);
    fs.writeFileSync(path.join(pkg, 'skill', 'SKILL.md'), 'v2'); // npm install -g replaced the package
    fs.writeFileSync(path.join(pkg, 'skill', 'commands', 'timesheet.md'), 'v2');
    sessionStartContext({ cwd: '/r' }, { now, git: probe('/r', []), pkgRoot: pkg });
    expect([fs.readFileSync(skill, 'utf8'), fs.readFileSync(cmd, 'utf8')]).toEqual(['v2', 'v2']);
  });

  it('does nothing before init', () => {
    expect(sessionStartContext({ cwd: '/r' }, { now, git: probe('/r', []) })).toBeNull();
    expect(recordTurn({ cwd: '/r', ...turn }, { now, git: probe('/r', []) })).toBe(false);
  });

  it('asks once for unknown folders and logs nothing there', () => {
    saveConfig(testConfig());
    const ctx = sessionStartContext({ cwd: '/side' }, { now, git: probe('/side', ['git@github.com:me/side.git']) });
    expect(ctx).toMatch(/Work, Personal, or Ignore/);
    expect(ctx).toContain('timesheet repo <work|personal|ignore> --path "/side"');
    expect(recordTurn({ cwd: '/side', ...turn }, { now, git: probe('/side', []) })).toBe(false);
    expect(fs.existsSync(paths.log('2026-W41'))).toBe(false);
  });

  it('saves org repos as work, asks for the project, and logs turns', () => {
    saveConfig(testConfig());
    const g = probe('/w', ['git@github.com:TheAgenticAI/boxsy.git']);
    const ctx = sessionStartContext({ cwd: '/w' }, { now, git: g });
    expect(loadRepos()['/w']).toEqual({ class: 'work', name: 'TheAgenticAI/boxsy' });
    expect(ctx).toMatch(/which project it bills to \(Boxsy\)/);
    expect(recordTurn({ cwd: '/w', ...turn }, { now, git: g })).toBe(true);
    const [line] = readJsonl<any>(paths.log('2026-W41'));
    expect(line).toEqual({ t: now.toISOString(), session: 's1', root: '/w', repo: 'TheAgenticAI/boxsy', project: null, transcript: '/t/s1.jsonl' });
  });

  it('stays silent for classified repos and never logs personal ones', () => {
    saveConfig(testConfig());
    saveRepos({ '/w': { class: 'work', project: 'Boxsy', name: 'TheAgenticAI/boxsy' }, '/p': { class: 'personal' } });
    expect(sessionStartContext({ cwd: '/w' }, { now, git: probe('/w', []) })).toBeNull();
    expect(recordTurn({ cwd: '/p', ...turn }, { now, git: probe('/p', []) })).toBe(false);
  });

  it('honours TIMESHEET_DISABLE_HOOKS', () => {
    saveConfig(testConfig());
    saveRepos({ '/w': { class: 'work', project: 'Boxsy' } });
    process.env.TIMESHEET_DISABLE_HOOKS = '1';
    expect(recordTurn({ cwd: '/w', ...turn }, { now, git: probe('/w', []) })).toBe(false);
    expect(sessionStartContext({ cwd: '/x' }, { now, git: probe('/x', []) })).toBeNull();
  });

  it('nudges on Sunday evening when the week has activity and is not pushed', () => {
    saveConfig(testConfig({ nudge: true }));
    saveRepos({ '/w': { class: 'work', project: 'Boxsy' } });
    const sunday = new Date(2026, 9, 11, 19, 0);
    appendLine(paths.log('2026-W41'), { t: sunday.toISOString() });
    expect(sessionStartContext({ cwd: '/w' }, { now: sunday, git: probe('/w', []) })).toMatch(/run \/timesheet/);
    const d = emptyDraft('2026-W41'); d.pushed = true; saveDraft(d);
    expect(sessionStartContext({ cwd: '/w' }, { now: sunday, git: probe('/w', []) })).toBeNull();
  });

  it('recordTurn is fast (< 50ms) with a fake git', () => {
    saveConfig(testConfig());
    saveRepos({ '/w': { class: 'work', project: 'Boxsy' } });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) recordTurn({ cwd: '/w', ...turn }, { now, git: probe('/w', []) });
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});
