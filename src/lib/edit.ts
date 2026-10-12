import { randomUUID } from 'node:crypto';
import { distribute } from './distribute.js';
import { homeOf, inGroup, members, normalizeGroups, sharedRef } from './groups.js';
import { weekdayName } from './week.js';
import type { Draft, Item } from './types.js';

function find(draft: Draft, id: string): Item {
  const item = draft.items.find(i => i.id === id && !i.deleted);
  if (!item) throw new Error(`No item ${id}.`);
  if (item.linear) throw new Error(`"${item.title}" is already pushed and can't be changed here.`);
  return item;
}
function single(draft: Draft, item: Item, what: string): void {
  if (inGroup(draft, item)) throw new Error(`"${item.title}" is logged on several days, so it can't be ${what}. Delete the days you don't want instead.`);
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
  single(draft, item, 'split');
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
  for (const i of [first, ...rest]) single(draft, i, 'merged');
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
  if (needsRemote(draft, item)) throw new Error(`"${item.title}" is the last day left on ${sharedRef(draft, item)!.identifier ?? 'its Linear issue'}, so deleting it removes that issue from Linear too. Confirm it from the delete dialog.`);
  item.deleted = true;
  item.hours = null;
  item.locked = false;
  return normalizeGroups(draft);
}

/**
 * True when deleting the item has to touch Linear or Everhour: it is in Linear itself, or it is the last live day
 * of an issue that is (`alsoGoing` are items deleted in the same step).
 */
export function needsRemote(draft: Draft, item: Item, alsoGoing: string[] = []): boolean {
  if (item.linear) return true;
  if (!sharedRef(draft, item)) return false;
  return members(draft, item).every(m => m.id === item.id || alsoGoing.includes(m.id));
}

/**
 * Logs one issue on more days: a copy per day that shares the issue's Linear issue and logs its own hours.
 * Copies start with the given hours, or the source's. Given hours, or a locked source's, stay locked through
 * Itemise; otherwise Itemise rebalances the copy like any other issue. Works on issues already in Linear: the copies are printed later onto the same issue.
 */
export function copyToDays(input: Draft, id: string, days: string[], hours?: number | null): { draft: Draft; ids: string[] } {
  const draft = structuredClone(input);
  const source = draft.items.find(i => i.id === id && !i.deleted);
  if (!source) throw new Error(`No issue with id ${id}.`);
  const want = [...new Set(days.map(String))];
  if (!want.length) throw new Error('Pick at least one day to copy to.');
  if (hours != null && !(hours > 0)) throw new Error('Hours must be more than 0.');
  const home = homeOf(draft, source);
  const taken = new Set(members(draft, source).map(m => m.day));
  for (const day of want) {
    if (!draft.days.includes(day)) throw new Error(`${weekdayName(day)} isn't a counted day this week.`);
    if (taken.has(day)) throw new Error(`"${source.title}" is already on ${weekdayName(day)}.`);
  }
  const h = hours ?? source.hours;
  const lock = h != null && (hours != null || source.locked); // hours Itemise chose stay Itemise's to change
  const ids = want.map(day => {
    const copy: Item = {
      id: randomUUID().slice(0, 8),
      title: home.title,
      description: home.description,
      project: home.project,
      bucketReason: `same issue as ${weekdayName(source.day)}`,
      day,
      evidence: { commits: [], sessions: [], manual: true },
      weight: source.weight,
      weightReason: source.weightReason,
      hours: h,
      locked: lock,
      edited: true,
      deleted: false,
      linear: null,
      everhour: null,
      sameAs: home.id,
    };
    draft.items.push(copy);
    return copy.id;
  });
  if (!home.linear) home.edited = true; // a redraft must not rename one day of the issue
  normalizeGroups(draft);
  if (draft.totalHours == null) return { draft, ids };
  return { draft: distribute(draft, { balance: false }).draft, ids };
}

/** The Add issue sheet: one issue on one or more days, with hours if given (each day gets the same). */
export function addIssue(input: Draft, a: { title: string; description: string; project: string | null; days: string[]; hours?: number | null }): { draft: Draft; ids: string[] } {
  const days = [...new Set(a.days)].sort();
  if (!days.length) throw new Error('Pick a day.');
  if (!String(a.title ?? '').trim()) throw new Error('Give the issue a title.');
  if (a.hours != null && !(a.hours > 0)) throw new Error('Hours must be more than 0.');
  let draft = addManualItem(input, { title: a.title, description: a.description, project: a.project, day: days[0] });
  const first = draft.items[draft.items.length - 1];
  if (a.hours != null) { first.hours = a.hours; first.locked = true; }
  if (days.length === 1) return { draft: draft.totalHours == null ? draft : distribute(draft, { balance: false }).draft, ids: [first.id] };
  const r = copyToDays(draft, first.id, days.slice(1), a.hours);
  return { draft: r.draft, ids: [first.id, ...r.ids] };
}
