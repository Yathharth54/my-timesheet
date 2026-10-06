import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, makeItem } from './helpers.js';
import { gitCommits, statsFor } from '../src/lib/evidence.js';

function commit(repo: string, email: string, iso: string, file: string, lines: number) {
  fs.writeFileSync(path.join(repo, file), 'x\n'.repeat(lines));
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', `user.email=${email}`, '-c', 'user.name=n', 'commit', '-q', '-m', `add ${file}`], {
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

describe('gitCommits', () => {
  it('returns only my commits inside the week with numstat totals', () => {
    const repo = tmpDir();
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    commit(repo, 'me@x.ai', '2026-10-01T10:00:00Z', 'old.txt', 1);
    commit(repo, 'me@x.ai', '2026-10-06T10:00:00Z', 'a.txt', 3);
    commit(repo, 'other@x.ai', '2026-10-06T11:00:00Z', 'b.txt', 2);
    const cs = gitCommits(repo, 'TheAgenticAI/demo', ['me@x.ai'], new Date('2026-10-05T00:00:00Z'), new Date('2026-10-12T00:00:00Z'));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ repo: 'TheAgenticAI/demo', day: '2026-10-06', subject: 'add a.txt', files: ['a.txt'], insertions: 3, deletions: 0 });
  });

  it('matches author emails exactly (case-insensitive), not by regex', () => {
    const repo = tmpDir();
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    commit(repo, 'someme@x.ai.uk', '2026-10-06T10:00:00Z', 'wrong.txt', 1);
    commit(repo, 'ME@x.ai', '2026-10-06T11:00:00Z', 'correct.txt', 1);
    const cs = gitCommits(repo, 'TheAgenticAI/demo', ['me@x.ai'], new Date('2026-10-05T00:00:00Z'), new Date('2026-10-12T00:00:00Z'));
    expect(cs).toHaveLength(1);
    expect(cs[0].subject).toBe('add correct.txt');
  });

  it('returns [] for a non-repo or no authors', () => {
    expect(gitCommits(tmpDir(), 'x', ['me@x.ai'], new Date(0), new Date())).toEqual([]);
    expect(gitCommits(tmpDir(), 'x', [], new Date(0), new Date())).toEqual([]);
  });
});

describe('statsFor', () => {
  it('sums commit and session evidence', () => {
    const item = makeItem({ evidence: { commits: ['c1', 'c2', 'missing'], sessions: ['s1'], manual: false } });
    const ev = {
      commits: {
        c1: { sha: 'c1', root: '/r', repo: 'r', at: '', day: '2026-10-05', subject: '', files: ['a', 'b'], insertions: 10, deletions: 2 },
        c2: { sha: 'c2', root: '/r', repo: 'r', at: '', day: '2026-10-06', subject: '', files: ['b'], insertions: 5, deletions: 0 },
      },
      sessions: { s1: { repo: 'r', project: null, prompts: 7, days: { '2026-10-05': { turns: 7, first: '', last: '' } } } },
    };
    expect(statsFor(item, ev)).toEqual({ commits: 2, insertions: 15, deletions: 2, files: 2, prompts: 7, sessions: 1, activeDays: 2 });
  });
});
