import { randomUUID } from 'node:crypto';
import type { Draft, Item, ProposedItem } from './types.js';

export function newItem(p: ProposedItem, id: string): Item {
  return {
    id,
    title: p.title.trim(),
    description: p.description.trim(),
    project: p.project,
    bucketReason: p.bucketReason,
    day: p.day,
    evidence: { commits: [...new Set(p.evidence.commits)], sessions: [...new Set(p.evidence.sessions)], manual: false },
    weight: null,
    weightReason: null,
    hours: null,
    locked: false,
    edited: false,
    deleted: false,
    linear: null,
    everhour: null,
  };
}

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

export function mergeProposal(
  draft: Draft,
  proposed: ProposedItem[],
  newId: () => string = () => randomUUID().slice(0, 8),
): { draft: Draft; added: number; updated: number; skipped: number } {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const coveredCommits = () => new Set(draft.items.flatMap(i => i.evidence.commits));

  for (const p of proposed) {
    const existing = p.id ? draft.items.find(i => i.id === p.id) : undefined;
    if (existing) {
      if (existing.linear || existing.deleted) { skipped++; continue; }
      existing.evidence.commits = union(existing.evidence.commits, p.evidence.commits);
      existing.evidence.sessions = union(existing.evidence.sessions, p.evidence.sessions);
      if (!existing.edited) {
        existing.title = p.title.trim();
        existing.description = p.description.trim();
        existing.project = p.project;
        existing.bucketReason = p.bucketReason;
        existing.day = p.day;
      }
      updated++;
      continue;
    }
    const commits = p.evidence.commits;
    if (commits.length > 0) {
      const covered = coveredCommits();
      if (commits.every(c => covered.has(c))) { skipped++; continue; }
    } else if (p.evidence.sessions.length > 0) {
      const tomb = draft.items.some(i => i.deleted && i.day === p.day && p.evidence.sessions.every(s => i.evidence.sessions.includes(s)));
      if (tomb) { skipped++; continue; }
    }
    draft.items.push(newItem(p, newId()));
    added++;
  }
  return { draft, added, updated, skipped };
}
