import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpHome } from './helpers.js';
import { parseRemote, classify, realGit, setRepo, type GitProbe } from '../src/lib/repo.js';
import { loadRepos } from '../src/lib/store.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

describe('parseRemote', () => {
  it.each([
    ['https://github.com/TheAgenticAI/boxsy-v2.0.git', 'TheAgenticAI', 'boxsy-v2.0'],
    ['git@github.com:TheAgenticAI/boxsy-v2.0.git', 'TheAgenticAI', 'boxsy-v2.0'],
    ['ssh://git@github.com/theagenticai/agentic-memory', 'theagenticai', 'agentic-memory'],
    ['https://github.com/Yathharth54/my-timesheet/', 'Yathharth54', 'my-timesheet'],
  ])('%s', (url, owner, name) => {
    expect(parseRemote(url)).toMatchObject({ host: 'github.com', owner, name });
  });
  it('returns null for junk', () => { expect(parseRemote('not a url')).toBeNull(); });
});

describe('classify', () => {
  const fake = (root: string, urls: string[]): GitProbe => ({ root: () => root, remoteUrls: () => urls });

  it('uses a saved answer first', () => {
    const c = classify('/r/sub', { '/r': { class: 'personal' } }, ['TheAgenticAI'], fake('/r', ['git@github.com:TheAgenticAI/x.git']));
    expect(c).toEqual({ kind: 'saved', root: '/r', entry: { class: 'personal' } });
  });
  it('matches work orgs case-insensitively on any remote (fork with upstream)', () => {
    const c = classify('/r', {}, ['TheAgenticAI'], fake('/r', ['git@github.com:me/x.git', 'https://github.com/theagenticai/x.git']));
    expect(c).toEqual({ kind: 'org', root: '/r', entry: { class: 'work', name: 'theagenticai/x' } });
  });
  it('is unknown otherwise and reports a slug', () => {
    expect(classify('/r', {}, ['TheAgenticAI'], fake('/r', ['git@github.com:me/side.git']))).toEqual({ kind: 'unknown', root: '/r', slug: 'me/side' });
    expect(classify('/r', {}, ['TheAgenticAI'], fake('/r', []))).toEqual({ kind: 'unknown', root: '/r', slug: null });
  });
});

describe('realGit', () => {
  beforeEach(() => { tmpHome(); });

  it('resolves subfolders and worktrees to the main repo root, folders with spaces too', () => {
    const base = tmpDir();
    const repo = path.join(base, 'timesheet skill');
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:TheAgenticAI/demo.git');
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    expect(realGit.root(path.join(repo, 'a', 'b'))).toBe(repo);
    expect(realGit.root(wt)).toBe(repo);
    expect(realGit.remoteUrls(repo)).toEqual(['git@github.com:TheAgenticAI/demo.git']);
  });

  it('falls back to the folder path when not a git repo or the folder is gone', () => {
    const dir = tmpDir();
    expect(realGit.root(dir)).toBe(dir);
    expect(realGit.root(path.join(dir, 'missing folder'))).toBe(path.join(dir, 'missing folder'));
    expect(realGit.remoteUrls(path.join(dir, 'missing folder'))).toEqual([]);
  });

  it('setRepo persists entries', () => {
    setRepo('/r', { class: 'work', project: 'Boxsy' });
    expect(loadRepos()['/r']).toEqual({ class: 'work', project: 'Boxsy' });
  });
});
