import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem, testConfig } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { removePushed } from '../src/lib/remove.js';
import { mergeProposal } from '../src/lib/merge.js';
import type { Draft } from '../src/lib/types.js';

const ref = (n: number) => ({ uuid: `u${n}`, identifier: `THE-${n}`, url: null, created: true });
const pushedDraft = (): Draft => makeDraft({
  totalHours: 5, pushed: true,
  items: [
    makeItem({ id: 'a', linear: ref(1), hours: 2, everhour: { logged: true }, evidence: { commits: ['c1'], sessions: ['s1'], manual: false } }),
    makeItem({ id: 'b', linear: ref(2), hours: 3, everhour: { logged: true }, day: '2026-10-06' }),
  ],
  parents: [
    { key: '2026-10-05|Boxsy', title: 'Mon', description: '', edited: false, linear: ref(10) },
    { key: '2026-10-06|Boxsy', title: 'Tue', description: '', edited: false, linear: ref(11) },
  ],
});

function setup() {
  const linear = new FakeLinear(), everhour = new FakeEverhour();
  everhour.times.set('u1|2026-10-05', 2);
  everhour.times.set('u2|2026-10-06', 3);
  const saves: number[] = [];
  const deps = { linear, everhour, config: testConfig(), save: (d: Draft) => { saves.push(d.rev); return d; } };
  return { linear, everhour, deps, saves };
}

describe('removePushed', () => {
  it('clears Everhour, trashes the issue and its now-empty parent, keeps a tombstone', async () => {
    const { linear, everhour, deps } = setup();
    const d = pushedDraft();
    const r = await removePushed(d, ['a'], deps);
    expect(r).toEqual({ removed: ['a'], parents: ['THE-10'], failed: [] });
    expect(everhour.times.get('u1|2026-10-05')).toBe(0);
    expect([...linear.trashed]).toEqual(['u1', 'u10']);
    expect(d.items[0]).toMatchObject({ deleted: true, hours: null, everhour: null, linear: ref(1) });
    expect(d.parents.map(p => p.key)).toEqual(['2026-10-06|Boxsy']);
    expect(d.totalHours).toBe(3);
  });

  it('keeps a parent that still has issues', async () => {
    const { linear, deps } = setup();
    const d = pushedDraft();
    d.items.push(makeItem({ id: 'c', day: '2026-10-05' }));
    const r = await removePushed(d, ['a'], deps);
    expect(r.parents).toEqual([]);
    expect(linear.trashed.has('u10')).toBe(false);
  });

  it('reports a Linear failure and finishes on a retry without touching Everhour twice', async () => {
    const { linear, everhour, deps } = setup();
    const d = pushedDraft();
    linear.failDeleteFor.add('u1');
    const r1 = await removePushed(d, ['a', 'b'], deps);
    expect(r1.removed).toEqual(['b']);
    expect(r1.failed).toEqual([{ id: 'a', step: 'linear', error: expect.stringMatching(/permission/) }]);
    expect(d.items[0]).toMatchObject({ deleted: false, everhour: null });
    const posts = everhour.posts;
    linear.failDeleteFor.clear();
    const r2 = await removePushed(d, ['a', 'b'], deps);
    expect(r2.failed).toEqual([]);
    expect(r2.removed).toEqual(['a', 'b']);
    expect(everhour.posts).toBe(posts);
    expect(d.parents).toEqual([]);
  });

  it('refuses items that are not in Linear', async () => {
    const { deps } = setup();
    const d = pushedDraft();
    d.items.push(makeItem({ id: 'local' }));
    const r = await removePushed(d, ['local', 'nope'], deps);
    expect(r.failed.map(f => f.id)).toEqual(['local', 'nope']);
  });

  it('a deleted pushed issue is never drafted again', async () => {
    const { deps } = setup();
    const d = pushedDraft();
    await removePushed(d, ['a'], deps);
    const again = { title: 'Again', description: 'Same work.', project: 'Boxsy', bucketReason: 'x', day: '2026-10-05', evidence: { commits: ['c1'], sessions: ['s1'] } };
    const out = mergeProposal(d, [{ id: 'a', ...again }, again]);
    expect(out.skipped).toBe(2);
    expect(out.draft.items.filter(i => !i.deleted).map(i => i.id)).toEqual(['b']);
  });
});
