import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { setHours, splitItem, mechanicalSplit, mergeItems, addManualItem, deleteItem } from '../src/lib/edit.js';

const pushedRef = { uuid: 'u', identifier: 'T-1', url: null, created: true };

describe('edit', () => {
  it('setHours locks the item and rebalances the rest to keep the total', () => {
    const d = makeDraft({ totalHours: 6, items: [makeItem({ id: 'a', hours: 2 }), makeItem({ id: 'b', hours: 2 }), makeItem({ id: 'c', hours: 2 })] });
    const out = setHours(d, 'a', 3);
    expect(out.items[0]).toMatchObject({ hours: 3, locked: true });
    expect(out.items[1].hours! + out.items[2].hours!).toBe(3);
    expect(d.items[0].hours).toBe(2);
  });

  it('setHours rejects pushed items and impossible values', () => {
    const d = makeDraft({ totalHours: 4, items: [makeItem({ id: 'a', hours: 2, linear: pushedRef }), makeItem({ id: 'b', hours: 2 })] });
    expect(() => setHours(d, 'a', 1)).toThrow(/already pushed/);
    expect(() => setHours(d, 'b', 9)).toThrow(/more than the 4h total/);
  });

  it('splitItem replaces an item with parts sharing evidence and weight', () => {
    const d = makeDraft({ items: [makeItem({ id: 'x', weight: 9, evidence: { commits: ['c'], sessions: [], manual: false } })] });
    const out = splitItem(d, 'x', mechanicalSplit({ title: 'Harness', description: 'Built it.' }, 3));
    expect(out.items.map(i => i.id)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(out.items.map(i => i.title)).toEqual(['Harness 1/3', 'Harness 2/3', 'Harness 3/3']);
    expect(out.items.every(i => i.weight === 3 && i.evidence.commits[0] === 'c' && i.hours === null)).toBe(true);
  });

  it('mergeItems combines two items into the first', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'a', title: 'A', description: 'One.', weight: 2, hours: 1, evidence: { commits: ['c1'], sessions: [], manual: false } }),
      makeItem({ id: 'b', title: 'B', description: 'Two.', weight: 3, hours: 2, evidence: { commits: ['c2'], sessions: ['s'], manual: false } }),
    ] });
    const out = mergeItems(d, ['a', 'b']);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: 'a', title: 'A', description: 'One. Two.', weight: 5, hours: 3, edited: true });
    expect(out.items[0].evidence).toEqual({ commits: ['c1', 'c2'], sessions: ['s'], manual: false });
  });

  it('addManualItem and deleteItem', () => {
    let d = addManualItem(makeDraft(), { title: 'Client call', description: 'Weekly sync.', project: 'Boxsy', day: '2026-10-06' });
    expect(d.items[0]).toMatchObject({ title: 'Client call', evidence: { manual: true }, edited: true });
    d = deleteItem(d, d.items[0].id);
    expect(d.items[0]).toMatchObject({ deleted: true, hours: null });
    const p = makeDraft({ items: [makeItem({ id: 'p', linear: pushedRef })] });
    expect(() => deleteItem(p, 'p')).toThrow(/already pushed/);
  });
});
