import { execFileSync } from 'node:child_process';
import { localDate } from './week.js';
import type { Commit, Item, WeekEvidence } from './types.js';

export function gitCommits(root: string, repo: string, authors: string[], from: Date, to: Date): Commit[] {
  if (!authors.length) return [];
  const authorLower = authors.map(a => a.toLowerCase());
  const args = [
    '-C', root, 'log', '--all', '--no-merges',
    `--since=${from.toISOString()}`, `--until=${to.toISOString()}`,
    '--format=%x1e%H%x1f%aI%x1f%ae%x1f%s', '--numstat', '--no-renames',
  ];
  let out: string;
  try {
    out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const commits: Commit[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const [header, ...rest] = rec.split('\n');
    const [sha, at, ae, subject] = header.split('\x1f');
    if (!sha || seen.has(sha)) continue;
    if (!authorLower.includes(ae.toLowerCase())) continue;
    seen.add(sha);
    const when = new Date(at);
    if (when < from || when >= to) continue;
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const l of rest) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push(m[3]);
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
    }
    commits.push({ sha, root, repo, at, day: localDate(when), subject, files, insertions, deletions });
  }
  return commits.sort((a, b) => a.at.localeCompare(b.at));
}

export interface EvidenceStats { commits: number; insertions: number; deletions: number; files: number; prompts: number; sessions: number; activeDays: number }

export function statsFor(item: Item, ev: WeekEvidence): EvidenceStats {
  const commits = item.evidence.commits.map(sha => ev.commits[sha]).filter(Boolean);
  const sessions = item.evidence.sessions.map(id => ev.sessions[id]).filter(Boolean);
  const files = new Set(commits.flatMap(c => c.files));
  const days = new Set([...commits.map(c => c.day), ...sessions.flatMap(s => Object.keys(s.days))]);
  return {
    commits: commits.length,
    insertions: commits.reduce((s, c) => s + c.insertions, 0),
    deletions: commits.reduce((s, c) => s + c.deletions, 0),
    files: files.size,
    prompts: sessions.reduce((s, x) => s + x.prompts, 0),
    sessions: sessions.length,
    activeDays: days.size,
  };
}
