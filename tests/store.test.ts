import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome, testConfig } from './helpers.js';
import { paths } from '../src/lib/paths.js';
import { appendLine, readJsonl, loadConfig, saveConfig, emptyDraft, saveDraft, loadDraft, listWeeks, requireConfig } from '../src/lib/store.js';

describe('store', () => {
  beforeEach(() => { tmpHome(); });

  it('returns null config before init and errors clearly when required', () => {
    expect(loadConfig()).toBeNull();
    expect(() => requireConfig()).toThrow(/timesheet init/);
    saveConfig(testConfig());
    expect(loadConfig()?.workOrgs).toEqual(['TheAgenticAI']);
  });

  it('skips corrupt JSONL lines', () => {
    const f = paths.log('2026-W41');
    appendLine(f, { a: 1 });
    fs.appendFileSync(f, '{broken\n');
    appendLine(f, { a: 2 });
    expect(readJsonl<{ a: number }>(f).map(x => x.a)).toEqual([1, 2]);
  });

  it('saveDraft bumps rev in place and lists weeks', () => {
    const d = emptyDraft('2026-W41');
    expect(d.days).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    const same = saveDraft(d);
    expect(same).toBe(d);
    expect(d.rev).toBe(1);
    expect(loadDraft('2026-W41')?.rev).toBe(1);
    expect(listWeeks()).toEqual(['2026-W41']);
  });

  it('throws a clear error on corrupt JSON', () => {
    fs.mkdirSync(paths.weekDir('2026-W41'), { recursive: true });
    fs.writeFileSync(paths.draft('2026-W41'), '{nope');
    expect(() => loadDraft('2026-W41')).toThrow(/Could not read/);
  });
});
