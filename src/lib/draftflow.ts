import fs from 'node:fs';
import { paths } from './paths.js';
import { emptyDraft, loadDraft, loadRepos, readJson, readJsonl, requireConfig, saveDraft, writeJsonAtomic } from './store.js';
import { weekDays, weekWindow } from './week.js';
import { condense } from './condense.js';
import { gitCommits } from './evidence.js';
import { mergeProposal } from './merge.js';
import { syncParents } from './parents.js';
import type { Commit, LogEntry, Proposal, WeekEvidence } from './types.js';

export function prepare(week: string): { contextPath: string; warnings: string[]; sessions: number; commits: number } {
  const config = requireConfig();
  const { from, to } = weekWindow(week);
  const warnings: string[] = [];

  const bySession = new Map<string, LogEntry>();
  for (const e of readJsonl<LogEntry>(paths.log(week))) if (!bySession.has(e.session)) bySession.set(e.session, e);
  const digests = [...bySession.values()].map(e => ({ ...condense(e.transcript, e.session, from, to), repo: e.repo, project: e.project }));
  const missing = digests.filter(d => d.missing).length;
  if (missing) warnings.push(`${missing} session transcript${missing === 1 ? ' is' : 's are'} missing (Claude Code deletes transcripts after 30 days); those sessions rely on commits only.`);

  const repos = loadRepos();
  const commits: Commit[] = [];
  for (const [root, entry] of Object.entries(repos)) {
    if (entry.class !== 'work') continue;
    commits.push(...gitCommits(root, entry.name ?? root, config.gitEmails, from, to));
  }

  const draft = loadDraft(week) ?? emptyDraft(week);
  const examples = readJsonl<unknown>(paths.examples()).slice(-30);

  const context = {
    week,
    days: weekDays(week),
    countedDays: draft.days,
    projects: config.projects.map(({ name, kind }) => ({ name, kind })),
    internalProject: config.internalProject,
    repos: Object.fromEntries(Object.entries(repos).filter(([, e]) => e.class === 'work').map(([root, e]) => [root, { name: e.name ?? root, project: e.project ?? null }])),
    sessions: digests.filter(d => !d.missing),
    commits: commits.map(c => ({ sha: c.sha, repo: c.repo, day: c.day, subject: c.subject, files: c.files.slice(0, 20), insertions: c.insertions, deletions: c.deletions })),
    existing: draft.items.map(i => ({ id: i.id, title: i.title, description: i.description, project: i.project, day: i.day, evidence: i.evidence, edited: i.edited, deleted: i.deleted, pushed: !!i.linear })),
    examples,
  };
  writeJsonAtomic(paths.context(week), context);

  const evidence: WeekEvidence = {
    commits: Object.fromEntries(commits.map(c => [c.sha, c])),
    sessions: Object.fromEntries(digests.map(d => [d.session, { repo: d.repo, project: d.project, prompts: d.prompts.length, days: d.days }])),
  };
  writeJsonAtomic(paths.evidence(week), evidence);

  return { contextPath: paths.context(week), warnings, sessions: digests.length, commits: commits.length };
}

function checkProposal(p: unknown): Proposal {
  const prop = p as Proposal;
  if (!prop || !Array.isArray(prop.items)) throw new Error('proposal.json must be an object with an "items" array.');
  prop.items.forEach((it, idx) => {
    const ok = it && typeof it.title === 'string' && typeof it.description === 'string' && typeof it.day === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(it.day) && it.evidence && Array.isArray(it.evidence.commits) && Array.isArray(it.evidence.sessions);
    if (!ok) throw new Error(`proposal.json item ${idx} needs title, description, day (YYYY-MM-DD) and evidence {commits, sessions}.`);
  });
  return prop;
}

export function ingest(week: string): { added: number; updated: number; skipped: number; items: number } {
  const proposal = checkProposal(readJson<unknown>(paths.proposal(week), null));
  const draft = loadDraft(week) ?? emptyDraft(week);
  const r = mergeProposal(draft, proposal.items.map(i => ({ ...i, project: i.project ?? null, bucketReason: i.bucketReason ?? '' })));
  const week7 = weekDays(week);
  for (const i of draft.items) if (!i.deleted && week7.includes(i.day) && !draft.days.includes(i.day)) draft.days.push(i.day);
  draft.days.sort();
  syncParents(draft, proposal.parents ?? []);
  saveDraft(draft);
  fs.rmSync(paths.context(week), { force: true });
  fs.rmSync(paths.proposal(week), { force: true });
  return { added: r.added, updated: r.updated, skipped: r.skipped, items: draft.items.filter(i => !i.deleted).length };
}
