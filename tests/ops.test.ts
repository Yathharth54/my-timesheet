import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { applyOps } from '../src/lib/ops.js';
import { assistPrompt, parseAssist } from '../src/lib/assist.js';
import { testConfig } from './helpers.js';

const P = ['Boxsy', 'Dev - Internal'];
const pushedRef = { uuid: 'u-p', identifier: 'THE-9', url: null, created: true };
const draft = () => makeDraft({ items: [
  makeItem({ id: 'a', title: 'Alpha', project: 'Boxsy' }),
  makeItem({ id: 'b', title: 'Beta', project: 'Boxsy', day: '2026-10-06' }),
  makeItem({ id: 'c', title: 'Gamma', project: 'Dev - Internal' }),
  makeItem({ id: 'p', title: 'Pushed', linear: pushedRef, hours: 2, everhour: { logged: true } }),
] });

describe('applyOps', () => {
  it('moves many issues to a project and day, logs bucket flips, leaves the input alone', () => {
    const d = draft();
    const r = applyOps(d, [{ op: 'set', ids: ['a', 'b'], project: 'Dev - Internal', day: '2026-10-07' }], P);
    expect(r.draft.items.filter(i => ['a', 'b'].includes(i.id)).every(i => i.project === 'Dev - Internal' && i.day === '2026-10-07')).toBe(true);
    expect(r.summary).toEqual(['Move 2 issues to Dev - Internal and to Wednesday']);
    expect(r.examples.map(e => e.kind)).toEqual(['bucket', 'bucket']);
    expect(d.items[0].project).toBe('Boxsy');
  });

  it('renames one issue, marks it edited and logs a rewrite', () => {
    const r = applyOps(draft(), [{ op: 'set', ids: ['a'], title: 'Better name' }], P);
    expect(r.draft.items[0]).toMatchObject({ title: 'Better name', edited: true });
    expect(r.examples.map(e => e.kind)).toEqual(['rewrite']);
    expect(() => applyOps(draft(), [{ op: 'set', ids: ['a', 'b'], title: 'X' }], P)).toThrow(/one issue at a time/);
  });

  it('rejects unknown ids, projects and days outside the week', () => {
    expect(() => applyOps(draft(), [{ op: 'set', ids: ['zz'], project: 'Boxsy' }], P)).toThrow(/No issue with id zz/);
    expect(() => applyOps(draft(), [{ op: 'set', ids: ['a'], project: 'Nope' }], P)).toThrow(/No project called Nope/);
    expect(() => applyOps(draft(), [{ op: 'set', ids: ['a'], day: '2026-11-01' }], P)).toThrow(/isn't in week/);
    expect(() => applyOps(draft(), [], P)).toThrow(/No changes/);
    expect(() => applyOps(draft(), [{ op: 'nuke' } as any], P)).toThrow(/Unknown op/);
  });

  it('refuses set, hours and merge on a pushed issue', () => {
    expect(() => applyOps(draft(), [{ op: 'set', ids: ['a', 'p'], project: 'Dev - Internal' }], P)).toThrow(/THE-9 is already in Linear/);
    expect(() => applyOps(draft(), [{ op: 'hours', id: 'p', hours: 1 }], P)).toThrow(/already in Linear/);
    expect(() => applyOps(draft(), [{ op: 'merge', ids: ['a', 'p'] }], P)).toThrow(/already in Linear/);
  });

  it('deletes local issues and hands pushed ones back as remote', () => {
    const r = applyOps(draft(), [{ op: 'delete', ids: ['a', 'p'] }], P);
    expect(r.draft.items.find(i => i.id === 'a')!.deleted).toBe(true);
    expect(r.draft.items.find(i => i.id === 'p')!.deleted).toBe(false);
    expect(r.remote).toEqual(['p']);
    expect(r.summary).toEqual(['Delete 2 issues (1 from Linear and Everhour too)']);
  });

  it('merges several into the first and says where they land', () => {
    const r = applyOps(draft(), [{ op: 'merge', ids: ['a', 'b', 'c'] }], P);
    expect(r.draft.items.filter(i => !i.deleted).map(i => i.id)).toEqual(['a', 'p']);
    expect(r.summary[0]).toBe('Merge 3 issues into "Alpha" (Monday, Boxsy)');
  });

  it('applies ops in order', () => {
    const r = applyOps(draft(), [{ op: 'set', ids: ['b'], day: '2026-10-05' }, { op: 'merge', ids: ['a', 'b'] }], P);
    expect(r.draft.items.filter(i => !i.deleted)).toHaveLength(3);
  });
});

describe('assist', () => {
  it('builds a prompt with every live issue and the rules', () => {
    const d = draft();
    d.items.push(makeItem({ id: 'gone', title: 'Gone', deleted: true }));
    const p = assistPrompt(d, testConfig(), 'move everything to internal', [{ message: 'hi', reply: 'hello' }]);
    expect(p).toContain('"id": "a"');
    expect(p).toContain('"inLinear": "THE-9"');
    expect(p).not.toContain('"id": "gone"');
    expect(p).toContain('Person: hi');
    expect(p.trim().endsWith('Person: move everything to internal')).toBe(true);
  });

  it('parses fenced or bare JSON and fails clearly on junk', () => {
    expect(parseAssist('Sure!\n```json\n{"reply":"ok","ops":[{"op":"delete","ids":["a"]}]}\n```')).toEqual({ reply: 'ok', ops: [{ op: 'delete', ids: ['a'] }] });
    expect(parseAssist('{"reply":"nothing to do"}')).toEqual({ reply: 'nothing to do', ops: [] });
    expect(() => parseAssist('no idea')).toThrow(/didn't return/);
  });
});
