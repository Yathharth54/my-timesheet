import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem, testConfig } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { addIssue, copyToDays, deleteItem, mergeItems, splitItem } from '../src/lib/edit.js';
import { applyOps } from '../src/lib/ops.js';
import { push } from '../src/lib/push.js';
import { removePushed } from '../src/lib/remove.js';
import { syncParents } from '../src/lib/parents.js';
import { validate } from '../src/lib/validate.js';
import { distribute } from '../src/lib/distribute.js';
import type { Draft } from '../src/lib/types.js';

const MON = '2026-10-05', TUE = '2026-10-06', WED = '2026-10-07', FRI = '2026-10-09';
const NAMES = ['Boxsy', 'Dev - Internal'];
const week = (o: Partial<Draft> = {}) => makeDraft({
  items: [
    makeItem({ id: 'sync', title: 'Team sync', project: 'Dev - Internal', day: TUE, hours: 1, locked: true, evidence: { commits: [], sessions: ['s1'], manual: false } }),
    makeItem({ id: 'w', title: 'Deck reader', day: MON, weight: 3 }),
  ],
  ...o,
});
const live = (d: Draft) => d.items.filter(i => !i.deleted);

describe('one issue on several days', () => {
  it('copyToDays adds a copy per day that shares the issue, keeps its hours locked and carries no evidence', () => {
    const { draft, ids } = copyToDays(week(), 'sync', [FRI, WED]);
    const copies = ids.map(id => draft.items.find(i => i.id === id)!);
    expect(copies.map(c => [c.day, c.sameAs, c.hours, c.locked, c.title, c.project])).toEqual([
      [FRI, 'sync', 1, true, 'Team sync', 'Dev - Internal'], [WED, 'sync', 1, true, 'Team sync', 'Dev - Internal'],
    ]);
    expect(copies[0].evidence).toEqual({ commits: [], sessions: [], manual: true });
    expect(draft.items.find(i => i.id === 'sync')!.edited).toBe(true); // a redraft can't rename one day of it
  });

  it('copyToDays takes new hours, rebalances the rest, and refuses days the issue has or the week does not count', () => {
    const d = copyToDays(week({ totalHours: 6 }), 'sync', [FRI], 2).draft;
    expect(d.items.map(i => [i.id === 'w' ? 'w' : i.day, i.hours])).toEqual([[TUE, 1], ['w', 3], [FRI, 2]]);
    expect(() => copyToDays(d, 'sync', [FRI])).toThrow(/already on Friday/);
    expect(() => copyToDays(week({ days: [MON, TUE] }), 'sync', [FRI])).toThrow(/Friday isn't a counted day/);
    expect(() => copyToDays(week({ totalHours: 1.5 }), 'sync', [FRI])).toThrow(/more than the 1.5h total/);
  });

  it('copies of a copy point at the home; renames and project moves reach every day', () => {
    let d = copyToDays(week(), 'sync', [WED]).draft;
    const wed = live(d).find(i => i.day === WED)!;
    d = copyToDays(d, wed.id, [FRI]).draft;
    expect(live(d).filter(i => i.sameAs).map(i => i.sameAs)).toEqual(['sync', 'sync']);
    const r = applyOps(d, [{ op: 'set', ids: [wed.id], title: 'Standup', project: 'Boxsy' }, { op: 'set', ids: [wed.id], day: MON }], NAMES);
    expect(live(r.draft).filter(i => i.id !== 'w').map(i => [i.day, i.title, i.project])).toEqual([[TUE, 'Standup', 'Boxsy'], [MON, 'Standup', 'Boxsy'], [FRI, 'Standup', 'Boxsy']]);
    expect(r.examples.filter(e => e.kind === 'rewrite')).toHaveLength(1);
    expect(() => applyOps(d, [{ op: 'set', ids: [wed.id], day: TUE }], NAMES)).toThrow(/on Tuesday twice/);
  });

  it('the copy op skips days an issue already has and summarises by title', () => {
    const r = applyOps(week(), [{ op: 'copy', ids: ['sync'], days: [WED, FRI], hours: 0.5 }], NAMES);
    expect(r.summary).toEqual(['Log "Team sync" on Wednesday, Friday too at 0.5h']);
    expect(() => applyOps(r.draft, [{ op: 'copy', ids: ['sync'], days: [WED] }], NAMES)).toThrow(/already on Wednesday/);
    expect(() => applyOps(r.draft, [{ op: 'merge', ids: ['sync', 'w'] }], NAMES)).toThrow(/several days/);
  });

  it('deleting the home before printing hands the issue to the earliest copy', () => {
    let d = copyToDays(week(), 'sync', [FRI, WED]).draft;
    d = deleteItem(d, 'sync');
    const wed = live(d).find(i => i.day === WED)!, fri = live(d).find(i => i.day === FRI)!;
    expect([wed.sameAs, fri.sameAs]).toEqual([null, wed.id]);
    expect(syncParents(d).parents.map(p => p.key)).toEqual([`${MON}|Boxsy`, `${WED}|Dev - Internal`]);
  });

  it('merge and split refuse a multi-day issue; balancing never moves its days', () => {
    const d = copyToDays(week(), 'sync', [FRI]).draft;
    expect(() => splitItem(d, 'sync', [{ title: 'a', description: 'x' }, { title: 'b', description: 'y' }])).toThrow(/several days/);
    expect(() => mergeItems(d, ['w', 'sync'])).toThrow(/several days/);
    const heavy = makeDraft({ totalHours: 9, items: [makeItem({ id: 'h', day: MON, weight: 1 }), makeItem({ id: 'c', day: MON, weight: 1, sameAs: 'h', evidence: { commits: [], sessions: [], manual: false } }), makeItem({ id: 'z', day: MON, weight: 1 })] });
    heavy.items[1].day = TUE; heavy.items[1].sameAs = 'h';
    const out = distribute(heavy).draft;
    expect(out.items.slice(0, 2).map(i => i.day)).toEqual([MON, TUE]);
  });

  it('validate blocks two days of one issue on the same day', () => {
    const d = copyToDays(week(), 'sync', [FRI]).draft;
    d.items[d.items.length - 1].day = TUE;
    expect(validate(d, NAMES).find(w => w.code === 'same_day_twice')?.message).toMatch(/"Team sync" is on Tuesday twice/);
  });

  it('a copy of an issue whose hours Itemise chose stays unlocked, so Itemise can rebalance it', () => {
    const d = copyToDays(week({ totalHours: 4 }), 'w', [FRI]).draft;
    const copy = d.items[d.items.length - 1];
    expect([copy.locked, copy.sameAs]).toEqual([false, 'w']);
    expect(copyToDays(week(), 'w', [FRI], 1).draft.items.at(-1)!.locked).toBe(true);
  });

  it('addIssue makes one issue on several days with the given hours', () => {
    const { draft, ids } = addIssue(makeDraft({ totalHours: 4, items: [makeItem({ id: 'w', weight: 1 })] }), { title: 'Client call', description: 'Weekly call.', project: 'Boxsy', days: [FRI, TUE], hours: 1 });
    expect(ids).toHaveLength(2);
    expect(draft.items.slice(1).map(i => [i.day, i.hours, i.locked, i.sameAs ?? null])).toEqual([[TUE, 1, true, null], [FRI, 1, true, ids[0]]]);
    expect(draft.items[0].hours).toBe(2);
  });
});

describe('printing and deleting a multi-day issue', () => {
  const ready = () => {
    const d = copyToDays(makeDraft({ totalHours: 3, items: [makeItem({ id: 'sync', title: 'Team sync', day: TUE, hours: 1, locked: true })] }), 'sync', [WED, FRI]).draft;
    return syncParents(d);
  };
  const deps = (linear: FakeLinear, everhour: FakeEverhour, saves: Draft[] = []) => {
    let n = 0;
    return { linear, everhour, config: testConfig(), save: (x: Draft) => { saves.push(structuredClone(x)); return x; }, newUuid: () => `g-${++n}` };
  };

  it('creates one Linear issue under the home day only and logs each day on it', async () => {
    const linear = new FakeLinear(), everhour = new FakeEverhour();
    const d = ready();
    expect(d.parents.map(p => p.key)).toEqual([`${TUE}|Boxsy`]);
    const r = await push(d, deps(linear, everhour));
    expect(r).toMatchObject({ status: 'done', issues: 1, hours: 3 });
    expect(linear.issues.size).toBe(2); // the Tuesday parent and the one issue
    const uuid = d.items[0].linear!.uuid;
    expect(new Set(d.items.map(i => i.linear!.uuid))).toEqual(new Set([uuid]));
    expect([...everhour.times].filter(([k]) => k.startsWith(uuid)).sort()).toEqual([[`${uuid}|${TUE}`, 1], [`${uuid}|${WED}`, 1], [`${uuid}|${FRI}`, 1]]);
  });

  it('a day copied after printing logs onto the same issue on the next print', async () => {
    const linear = new FakeLinear(), everhour = new FakeEverhour();
    let d = syncParents(makeDraft({ totalHours: 1, items: [makeItem({ id: 'sync', day: TUE, hours: 1, locked: true })] }));
    await push(d, deps(linear, everhour));
    d = copyToDays({ ...d, totalHours: 2 }, 'sync', [FRI]).draft;
    expect(applyOps(d, [{ op: 'set', ids: [d.items[1].id], day: WED }], NAMES).draft.items[1].day).toBe(WED); // its day can still move
    expect(() => applyOps(d, [{ op: 'set', ids: [d.items[1].id], title: 'Renamed' }], NAMES)).toThrow(/already in Linear/);
    const before = linear.issues.size;
    const r = await push(syncParents(d), deps(linear, everhour));
    expect(r).toMatchObject({ status: 'done', issues: 1 });
    expect(linear.issues.size).toBe(before);
    expect(everhour.times.get(`${d.items[0].linear!.uuid}|${FRI}`)).toBe(1);
  });

  it('deleting one printed day clears only that day; the issue is trashed with its last day', async () => {
    const linear = new FakeLinear(), everhour = new FakeEverhour();
    const d = ready();
    await push(d, deps(linear, everhour));
    const uuid = d.items[0].linear!.uuid;
    const [tue, wed, fri] = d.items.map(i => i.id);
    expect(applyOps(d, [{ op: 'delete', ids: [wed] }], NAMES).remote).toEqual([wed]);
    let r = await removePushed(d, [tue], deps(linear, everhour));
    expect(r).toMatchObject({ removed: [tue], parents: [], failed: [] });
    expect(everhour.times.get(`${uuid}|${TUE}`)).toBe(0);
    expect(linear.trashed.size).toBe(0);
    expect(syncParents(d).parents).toHaveLength(1); // the Tuesday parent still holds the issue
    r = await removePushed(d, [wed, fri], deps(linear, everhour));
    expect(r.parents).toHaveLength(1);
    expect(linear.trashed.has(uuid)).toBe(true);
    expect(d.totalHours).toBe(null);
  });

  it('an unprinted day is deleted locally unless it is the last one on a printed issue', async () => {
    const linear = new FakeLinear(), everhour = new FakeEverhour();
    let d = syncParents(makeDraft({ totalHours: 1, items: [makeItem({ id: 'sync', day: TUE, hours: 1, locked: true })] }));
    await push(d, deps(linear, everhour));
    d = copyToDays({ ...d, totalHours: 2 }, 'sync', [FRI]).draft;
    const fri = d.items[1].id;
    expect(applyOps(d, [{ op: 'delete', ids: [fri] }], NAMES).remote).toEqual([]);
    d = (await (async () => { await removePushed(d, ['sync'], deps(linear, everhour)); return d; })());
    expect(linear.trashed.size).toBe(0); // Friday still needs the issue
    expect(() => deleteItem(d, fri)).toThrow(/last day left/);
    expect(applyOps(d, [{ op: 'delete', ids: [fri] }], NAMES).remote).toEqual([fri]);
    await removePushed(d, [fri], deps(linear, everhour));
    expect(linear.trashed.has(d.items[0].linear!.uuid)).toBe(true);
  });
});
