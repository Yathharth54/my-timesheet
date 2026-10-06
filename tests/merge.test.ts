import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { mergeProposal } from '../src/lib/merge.js';
import type { ProposedItem } from '../src/lib/types.js';

const p = (o: Partial<ProposedItem> = {}): ProposedItem => ({
  title: 'New work', description: 'Did it.', project: 'Boxsy', bucketReason: 'client', day: '2026-10-05',
  evidence: { commits: [], sessions: [] }, ...o,
});
let n = 0;
const ids = () => `n${++n}`;

describe('mergeProposal', () => {
  it('adds new items', () => {
    const r = mergeProposal(makeDraft(), [p({ evidence: { commits: ['c1'], sessions: ['s1'] } })], ids);
    expect(r.added).toBe(1);
    expect(r.draft.items[0]).toMatchObject({ title: 'New work', evidence: { commits: ['c1'], sessions: ['s1'], manual: false }, hours: null });
  });

  it('updates unedited items by id but only unions evidence on edited ones', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'a', title: 'Old', evidence: { commits: ['c1'], sessions: [], manual: false } }),
      makeItem({ id: 'b', title: 'Mine', edited: true }),
    ] });
    const r = mergeProposal(d, [
      p({ id: 'a', title: 'Renamed', evidence: { commits: ['c2'], sessions: [] } }),
      p({ id: 'b', title: 'Overwrite?', evidence: { commits: ['c3'], sessions: [] } }),
    ], ids);
    expect(r.updated).toBe(2);
    expect(d.items[0].title).toBe('Renamed');
    expect(d.items[0].evidence.commits).toEqual(['c1', 'c2']);
    expect(d.items[1].title).toBe('Mine');
    expect(d.items[1].evidence.commits).toEqual(['c3']);
  });

  it('never touches pushed or deleted items and never recreates tombstoned work', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'pushed', title: 'P', linear: { uuid: 'u', identifier: 'T-1', url: null, created: true } }),
      makeItem({ id: 'dead', deleted: true, evidence: { commits: ['c9'], sessions: ['s9'], manual: false } }),
    ] });
    const r = mergeProposal(d, [
      p({ id: 'pushed', title: 'changed' }),
      p({ title: 'Recreated from commit', evidence: { commits: ['c9'], sessions: [] } }),
      p({ title: 'Recreated from session', evidence: { commits: [], sessions: ['s9'] } }),
      p({ title: 'Genuinely new, same session other day', day: '2026-10-06', evidence: { commits: [], sessions: ['s9'] } }),
    ], ids);
    expect(d.items[0].title).toBe('P');
    expect(r.skipped).toBe(3);
    expect(r.added).toBe(1);
    expect(d.items.map(i => i.title)).toContain('Genuinely new, same session other day');
  });
});
