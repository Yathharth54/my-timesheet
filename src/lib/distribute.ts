import { dayDistance } from './week.js';
import type { Draft, Item } from './types.js';

export const UNIT = 0.5;
export const MAX_ITEM_HOURS = 3;
const EPS = 1e-9;

export function allocate(totalHours: number, items: { id: string; weight: number }[]): Map<string, number> {
  const units = Math.round(totalHours / UNIT);
  if (Math.abs(units * UNIT - totalHours) > EPS) throw new Error(`Total must be a multiple of ${UNIT}h (got ${totalHours}).`);
  const out = new Map<string, number>();
  if (items.length === 0) {
    if (units !== 0) throw new Error('There are no unlocked items to put the remaining hours on.');
    return out;
  }
  if (units < items.length) throw new Error(`${totalHours}h is too little for ${items.length} items (each needs at least ${UNIT}h).`);
  const weights = items.map(i => (Number.isFinite(i.weight) && i.weight > 0 ? i.weight : 1));
  const W = weights.reduce((a, b) => a + b, 0);
  const spare = units - items.length;
  const raw = weights.map(w => (spare * w) / W);
  const given = raw.map(Math.floor);
  let left = spare - given.reduce((a, b) => a + b, 0);
  const order = items.map((_, i) => i).sort((a, b) => (raw[b] - given[b]) - (raw[a] - given[a]) || items[a].id.localeCompare(items[b].id));
  for (const i of order) {
    if (left <= 0) break;
    given[i] += 1;
    left -= 1;
  }
  items.forEach((it, i) => out.set(it.id, (1 + given[i]) * UNIT));
  return out;
}

const isFixed = (i: Item): boolean => i.locked || i.linear !== null;
const roundH = (n: number): number => Math.round(n * 1e6) / 1e6;

export function distribute(input: Draft, opts: { balance?: boolean } = {}): { draft: Draft; needsSplit: string[] } {
  const draft = structuredClone(input);
  if (draft.totalHours == null) throw new Error('Enter the total hours for the week first.');
  const active = draft.items.filter(i => !i.deleted);
  const fixedSum = roundH(active.filter(isFixed).reduce((s, i) => s + (i.hours ?? 0), 0));
  const remaining = roundH(draft.totalHours - fixedSum);
  if (remaining < -EPS) throw new Error(`Locked items already add up to ${fixedSum}h, more than the ${draft.totalHours}h total.`);
  const free = active.filter(i => !isFixed(i));
  const alloc = allocate(Math.max(0, remaining), free.map(i => ({ id: i.id, weight: i.weight ?? 1 })));
  for (const i of free) i.hours = alloc.get(i.id)!;
  const needsSplit = free.filter(i => (i.hours ?? 0) > MAX_ITEM_HOURS).map(i => i.id);
  if (needsSplit.length === 0 && opts.balance !== false) balanceDays(draft);
  return { draft, needsSplit };
}

export function nearestDay(day: string, days: string[]): string {
  return [...days].sort((a, b) => dayDistance(day, a) - dayDistance(day, b) || a.localeCompare(b))[0];
}

/**
 * Greedy: move items off the heaviest day to the nearest under-average day until every day is within ±1h of the
 * average. Pushed items never move. Locked and hand-added items stay on their day (and still count toward its
 * load); they only move when their day isn't counted, so they land somewhere counted.
 */
export function balanceDays(draft: Draft): void {
  const days = [...draft.days].sort();
  if (days.length === 0) return;
  const items = draft.items.filter(i => !i.deleted);
  for (const i of items) if (!i.linear && !days.includes(i.day)) i.day = nearestDay(i.day, days);
  const load = new Map(days.map(d => [d, 0]));
  for (const i of items) if (load.has(i.day)) load.set(i.day, load.get(i.day)! + (i.hours ?? 0));
  const avg = [...load.values()].reduce((a, b) => a + b, 0) / days.length;
  const movable = (i: Item) => !i.linear && !i.locked && !i.evidence.manual && (i.hours ?? 0) > 0;
  for (let guard = 0; guard < 1000; guard++) {
    const sorted = [...load].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [hi, hiLoad] = sorted[0];
    const loLoad = sorted[sorted.length - 1][1];
    if (hiLoad - avg <= 1 + EPS && avg - loLoad <= 1 + EPS) break;
    const targets = [...load].filter(([d, l]) => d !== hi && l < avg - EPS)
      .sort((a, b) => dayDistance(hi, a[0]) - dayDistance(hi, b[0]) || a[1] - b[1] || a[0].localeCompare(b[0]));
    let moved = false;
    for (const [lo, toLoad] of targets) {
      const spread = hiLoad - toLoad;
      const candidates = items.filter(i => i.day === hi && movable(i) && i.hours! < spread - EPS);
      if (!candidates.length) continue;
      candidates.sort((a, b) => Math.abs(spread - 2 * a.hours!) - Math.abs(spread - 2 * b.hours!) || a.id.localeCompare(b.id));
      const pick = candidates[0];
      pick.day = lo;
      load.set(hi, hiLoad - pick.hours!);
      load.set(lo, toLoad + pick.hours!);
      moved = true;
      break;
    }
    if (!moved) break;
  }
}
