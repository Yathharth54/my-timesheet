import { randomUUID } from 'node:crypto';
import { distribute } from './distribute.js';
import type { Draft, Item } from './types.js';

function find(draft: Draft, id: string): Item {
  const item = draft.items.find(i => i.id === id && !i.deleted);
  if (!item) throw new Error(`No item ${id}.`);
  if (item.linear) throw new Error(`"${item.title}" is already pushed and can't be changed here.`);
  return item;
}

export function setHours(input: Draft, id: string, hours: number): Draft {
  const draft = structuredClone(input);
  const item = find(draft, id);
  if (!(hours > 0)) throw new Error('Hours must be more than 0.');
  item.hours = hours;
  item.locked = true;
  if (draft.totalHours == null) return draft;
  return distribute(draft, { balance: false }).draft;
}

export function mechanicalSplit(item: { title: string; description: string }, k: number): { title: string; description: string }[] {
  return Array.from({ length: k }, (_, i) => ({ title: `${item.title} ${i + 1}/${k}`, description: item.description }));
}

export function splitItem(input: Draft, id: string, parts: { title: string; description: string }[]): Draft {
  const draft = structuredClone(input);
  const item = find(draft, id);
  if (parts.length < 2) throw new Error('A split needs at least 2 parts.');
  const w = (item.weight ?? 1) / parts.length;
  const replacements: Item[] = parts.map((p, k) => ({
    ...structuredClone(item),
    id: `${item.id}-${k + 1}`,
    title: p.title.trim(),
    description: p.description.trim(),
    weight: w,
    hours: null,
    locked: false,
    edited: false,
  }));
  draft.items.splice(draft.items.indexOf(item), 1, ...replacements);
  return draft;
}

export function mergeItems(input: Draft, ids: string[]): Draft {
  const draft = structuredClone(input);
  if (ids.length < 2) throw new Error('Pick at least 2 items to merge.');
  const [first, ...rest] = ids.map(id => find(draft, id));
  for (const other of rest) {
    first.description = `${first.description.trim()} ${other.description.trim()}`;
    first.evidence.commits = [...new Set([...first.evidence.commits, ...other.evidence.commits])];
    first.evidence.sessions = [...new Set([...first.evidence.sessions, ...other.evidence.sessions])];
    first.weight = (first.weight ?? 1) + (other.weight ?? 1);
    first.hours = first.hours != null && other.hours != null ? first.hours + other.hours : null;
    draft.items.splice(draft.items.indexOf(other), 1);
  }
  first.edited = true;
  first.locked = false;
  return draft;
}

export function addManualItem(input: Draft, a: { title: string; description: string; project: string | null; day: string }): Draft {
  const draft = structuredClone(input);
  draft.items.push({
    id: randomUUID().slice(0, 8),
    title: a.title.trim(),
    description: a.description.trim(),
    project: a.project,
    bucketReason: 'added by hand',
    day: a.day,
    evidence: { commits: [], sessions: [], manual: true },
    weight: null,
    weightReason: null,
    hours: null,
    locked: false,
    edited: true,
    deleted: false,
    linear: null,
    everhour: null,
  });
  return draft;
}

export function deleteItem(input: Draft, id: string): Draft {
  const draft = structuredClone(input);
  const item = find(draft, id);
  item.deleted = true;
  item.hours = null;
  item.locked = false;
  return draft;
}
