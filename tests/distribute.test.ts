import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { allocate, distribute, balanceDays } from '../src/lib/distribute.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

describe('allocate', () => {
  it('splits by weight with largest remainder', () => {
    expect([...allocate(4, [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }])]).toEqual([['a', 3], ['b', 1]]);
  });

  it('always sums exactly, in 0.5h steps, each at least 0.5h (property)', () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(r() * 40);
      const items = Array.from({ length: count }, (_, i) => ({ id: `x${i}`, weight: 1 + Math.floor(r() * 10) }));
      const total = 0.5 * (count + Math.floor(r() * 120));
      const out = [...allocate(total, items).values()];
      expect(sum(out)).toBe(total);
      for (const h of out) { expect(h).toBeGreaterThanOrEqual(0.5); expect((h * 2) % 1).toBe(0); }
    }
  });

  it('rejects impossible totals with clear messages', () => {
    expect(() => allocate(67.3, [{ id: 'a', weight: 1 }])).toThrow(/multiple of 0.5h/);
    expect(() => allocate(1, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }])).toThrow(/too little for 3 items/);
  });
});

describe('distribute', () => {
  it('respects locks and pushed items, fills the rest, and flags items over 3h', () => {
    const d = makeDraft({ totalHours: 10, items: [
      makeItem({ id: 'locked', hours: 2, locked: true }),
      makeItem({ id: 'pushed', hours: 1, linear: { uuid: 'u', identifier: 'T', url: null, created: true } }),
      makeItem({ id: 'big', weight: 10 }),
      makeItem({ id: 'small', weight: 1 }),
    ] });
    const { draft, needsSplit } = distribute(d);
    expect(draft.items.find(i => i.id === 'locked')!.hours).toBe(2);
    expect(sum(draft.items.map(i => i.hours ?? 0))).toBe(10);
    expect(needsSplit).toEqual(['big']);
    expect(d.items[2].hours).toBeNull();
  });

  it('errors when locked hours exceed the total or the total is missing', () => {
    expect(() => distribute(makeDraft({ totalHours: 1, items: [makeItem({ hours: 2, locked: true })] }))).toThrow(/more than the 1h total/);
    expect(() => distribute(makeDraft({ items: [makeItem()] }))).toThrow(/Enter the total/);
  });
});

describe('balanceDays', () => {
  it('evens out days and moves items off uncounted days', () => {
    const items = Array.from({ length: 9 }, (_, i) => makeItem({ id: `m${i}`, day: '2026-10-05', hours: 2 }));
    items.push(makeItem({ id: 'sat', day: '2026-10-10', hours: 2 }));
    const d = makeDraft({ totalHours: 20, items });
    balanceDays(d);
    const load = new Map<string, number>();
    for (const i of d.items) load.set(i.day, (load.get(i.day) ?? 0) + i.hours!);
    expect([...load.keys()].sort()).toEqual(d.days);
    for (const v of load.values()) expect(Math.abs(v - 20 / 5)).toBeLessThanOrEqual(1);
  });

  it('never moves pushed items', () => {
    const pushed = makeItem({ id: 'p', day: '2026-10-05', hours: 3, linear: { uuid: 'u', identifier: 'T', url: null, created: true } });
    const d = makeDraft({ items: [pushed, makeItem({ day: '2026-10-05', hours: 3 })] });
    balanceDays(d);
    expect(d.items[0].day).toBe('2026-10-05');
  });

  it('keeps locked and hand-added items on their day, but still counts them', () => {
    const manual = { commits: [], sessions: [], manual: true };
    const d = makeDraft({ items: [
      makeItem({ id: 'locked', day: '2026-10-05', hours: 3, locked: true }),
      makeItem({ id: 'hand', day: '2026-10-05', hours: 3, evidence: manual }),
      makeItem({ id: 'free', day: '2026-10-05', hours: 1 }),
      makeItem({ id: 'sat', day: '2026-10-10', hours: 1, evidence: manual }),
    ] });
    balanceDays(d);
    const day = (id: string) => d.items.find(i => i.id === id)!.day;
    expect(day('locked')).toBe('2026-10-05');
    expect(day('hand')).toBe('2026-10-05');
    expect(day('free')).not.toBe('2026-10-05');
    expect(day('sat')).toBe('2026-10-09');
  });

  it('moves work to the nearest under-average day, not the globally lightest', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'one', day: '2026-10-05', hours: 1.5 }),
      makeItem({ id: 'two', day: '2026-10-05', hours: 2 }),
      makeItem({ id: 'three', day: '2026-10-05', hours: 3.5 }),
      makeItem({ id: 'tue', day: '2026-10-06', hours: 2.5 }),
      makeItem({ id: 'wed', day: '2026-10-07', hours: 5 }),
      makeItem({ id: 'thu', day: '2026-10-08', hours: 5 }),
      makeItem({ id: 'fri', day: '2026-10-09', hours: 0.5 }),
    ] });
    balanceDays(d);
    expect(d.items.find(i => i.id === 'two')!.day).toBe('2026-10-06');
  });
});
