import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig, saveRepos, appendLine, loadDraft, writeJsonAtomic } from '../src/lib/store.js';
import { paths } from '../src/lib/paths.js';
import { prepare, ingest } from '../src/lib/draftflow.js';

describe('prepare / ingest', () => {
  let repo: string;
  beforeEach(() => {
    tmpHome();
    saveConfig(testConfig());
    repo = tmpDir();
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'a.py'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=me@x.ai', '-c', 'user.name=n', 'commit', '-q', '-m', 'feat: a'], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-06T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-06T10:00:00Z' },
    });
    saveRepos({ [repo]: { class: 'work', project: 'Boxsy', name: 'TheAgenticAI/demo' }, '/personal': { class: 'personal' } });
    const transcript = path.join(tmpDir(), 's1.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-06T09:00:00Z', message: { content: 'add a.py' } }) + '\n');
    appendLine(paths.log('2026-W41'), { t: '2026-10-06T09:00:00Z', session: 's1', root: repo, repo: 'TheAgenticAI/demo', project: 'Boxsy', transcript });
    appendLine(paths.log('2026-W41'), { t: '2026-10-06T09:05:00Z', session: 's2', root: repo, repo: 'TheAgenticAI/demo', project: 'Boxsy', transcript: '/gone.jsonl' });
  });

  it('prepare writes a context bundle and evidence, warning about missing transcripts', () => {
    const r = prepare('2026-W41');
    expect(r.sessions).toBe(2);
    expect(r.commits).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 session transcript is missing/);
    const ctx = JSON.parse(fs.readFileSync(r.contextPath, 'utf8'));
    expect(ctx.projects).toEqual([{ name: 'Boxsy', kind: 'billable' }, { name: 'Dev - Internal', kind: 'internal' }]);
    expect(ctx.sessions[0].prompts).toEqual(['add a.py']);
    expect(ctx.commits[0].subject).toBe('feat: a');
    const ev = JSON.parse(fs.readFileSync(paths.evidence('2026-W41'), 'utf8'));
    expect(Object.keys(ev.commits)).toHaveLength(1);
    expect(ev.sessions.s1.prompts).toBe(1);
    expect(JSON.stringify(ev)).not.toContain('add a.py');
  });

  it('ingest merges the proposal, adds weekend days with items, and removes temp files', () => {
    const { contextPath } = prepare('2026-W41');
    const sha = JSON.parse(fs.readFileSync(contextPath, 'utf8')).commits[0].sha;
    writeJsonAtomic(paths.proposal('2026-W41'), {
      items: [
        { title: 'Prefill module', description: 'Added a.py.', project: 'Boxsy', bucketReason: 'client feature', day: '2026-10-06', evidence: { commits: [sha], sessions: ['s1'] } },
        { title: 'Weekend probe', description: 'Probed.', project: 'Dev - Internal', bucketReason: 'research', day: '2026-10-10', evidence: { commits: [], sessions: ['s2'] } },
      ],
      parents: [{ key: '2026-10-06|Boxsy', title: 'Tuesday — Prefill', description: '## 2026-10-06\n\nBuilt the prefill module.' }],
    });
    const r = ingest('2026-W41');
    expect(r).toMatchObject({ added: 2, items: 2 });
    const d = loadDraft('2026-W41')!;
    expect(d.days).toContain('2026-10-10');
    expect(d.parents.find(p => p.key === '2026-10-06|Boxsy')?.title).toBe('Tuesday — Prefill');
    expect(fs.existsSync(paths.context('2026-W41'))).toBe(false);
    expect(fs.existsSync(paths.proposal('2026-W41'))).toBe(false);
  });

  it('ingest rejects a malformed proposal without touching the draft', () => {
    writeJsonAtomic(paths.proposal('2026-W41'), { items: [{ title: 'no day' }] });
    expect(() => ingest('2026-W41')).toThrow(/proposal\.json item 0/);
    expect(loadDraft('2026-W41')).toBeNull();
  });
});
