import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRepos, saveRepos } from './store.js';
import type { RepoEntry, Repos } from './types.js';

export interface Remote { host: string; owner: string; name: string }

export function parseRemote(url: string): Remote | null {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { host: m[1], owner: m[2], name: m[3] } : null;
}

export interface GitProbe { root(cwd: string): string; remoteUrls(root: string): string[] }

const run = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();

export const realGit: GitProbe = {
  root(cwd) {
    try {
      const common = run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (path.basename(common) === '.git') return path.dirname(common);
      return run(cwd, ['rev-parse', '--show-toplevel']);
    } catch {
      return path.resolve(cwd);
    }
  },
  remoteUrls(root) {
    try {
      const lines = run(root, ['remote', '-v']).split('\n').filter(Boolean);
      const byName = new Map<string, string>();
      for (const l of lines) {
        const [name, url] = l.split(/\s+/);
        if (name && url && !byName.has(name)) byName.set(name, url);
      }
      const names = [...byName.keys()].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));
      return names.map(n => byName.get(n)!);
    } catch {
      return [];
    }
  },
};

export type Classification =
  | { kind: 'saved'; root: string; entry: RepoEntry }
  | { kind: 'org'; root: string; entry: RepoEntry }
  | { kind: 'unknown'; root: string; slug: string | null };

export function classify(cwd: string, repos: Repos, workOrgs: string[], git: GitProbe = realGit): Classification {
  const root = git.root(cwd);
  const saved = repos[root];
  if (saved) return { kind: 'saved', root, entry: saved };
  const remotes = git.remoteUrls(root).map(parseRemote).filter((r): r is Remote => r !== null);
  const orgs = new Set(workOrgs.map(o => o.toLowerCase()));
  const hit = remotes.find(r => orgs.has(r.owner.toLowerCase()));
  if (hit) return { kind: 'org', root, entry: { class: 'work', name: `${hit.owner}/${hit.name}` } };
  return { kind: 'unknown', root, slug: remotes[0] ? `${remotes[0].owner}/${remotes[0].name}` : null };
}

export function slugFor(root: string, git: GitProbe = realGit): string | null {
  const r = git.remoteUrls(root).map(parseRemote).find(Boolean);
  return r ? `${r.owner}/${r.name}` : null;
}

export function setRepo(root: string, entry: RepoEntry): void {
  const repos = loadRepos();
  repos[root] = entry;
  saveRepos(repos);
}
