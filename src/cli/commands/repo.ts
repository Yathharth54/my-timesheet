import fs from 'node:fs';
import { realGit, slugFor } from '../../lib/repo.js';
import { loadRepos, requireConfig, saveRepos } from '../../lib/store.js';
import type { RepoClass } from '../../lib/types.js';
import { ok } from '../out.js';

export function repo(args: string[], values: { path?: string; project?: string }): void {
  const cls = args[0] as RepoClass;
  if (!['work', 'personal', 'ignore'].includes(cls)) throw new Error('Usage: timesheet repo <work|personal|ignore> [--path P] [--project NAME]');
  const config = requireConfig();
  const target = values.path ?? process.cwd();
  if (!fs.existsSync(target)) throw new Error(`No such folder: ${target}`);
  if (values.project && !config.projects.some(p => p.name === values.project)) {
    throw new Error(`Unknown project "${values.project}". Known: ${config.projects.map(p => p.name).join(', ')}`);
  }
  const root = realGit.root(target);
  const repos = loadRepos();
  const prev = repos[root];
  repos[root] = {
    class: cls,
    name: prev?.name ?? slugFor(root) ?? undefined,
    project: cls === 'work' ? values.project ?? prev?.project : undefined,
  };
  saveRepos(repos);
  ok(`${repos[root].name ?? root} → ${cls}${repos[root].project ? ` (${repos[root].project})` : ''}`);
}
