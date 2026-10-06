import { weekdayName } from './week.js';
import type { Draft, Parent, ProposedParent } from './types.js';

export const parentKey = (day: string, project: string): string => `${day}|${project}`;

export function withCount(desc: string, n: number): string {
  const line = `${n} sub-task${n === 1 ? '' : 's'}.`;
  return /\d+ sub-tasks?\.\s*$/.test(desc) ? desc.replace(/\d+ sub-tasks?\.\s*$/, line) : `${desc.trimEnd()}\n\n${line}`;
}

export function syncParents(draft: Draft, proposed: ProposedParent[] = []): Draft {
  const counts = new Map<string, number>();
  for (const i of draft.items) {
    if (i.deleted || !i.project) continue;
    const k = parentKey(i.day, i.project);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const existing = new Map(draft.parents.map(p => [p.key, p]));
  const suggestions = new Map(proposed.map(p => [p.key, p]));
  const out: Parent[] = [];
  for (const [key, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const [day, project] = key.split('|');
    const p: Parent = existing.get(key) ?? { key, title: `${weekdayName(day)} — ${project}`, description: `## ${day}`, edited: false, linear: null };
    const s = suggestions.get(key);
    if (s && !p.edited && !p.linear) {
      p.title = s.title.trim();
      p.description = s.description.trim();
    }
    if (!p.linear) p.description = withCount(p.description, n);
    out.push(p);
  }
  for (const p of draft.parents) if (p.linear && !counts.has(p.key)) out.push(p);
  draft.parents = out;
  return draft;
}
