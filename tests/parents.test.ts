import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { syncParents, withCount } from '../src/lib/parents.js';

describe('syncParents', () => {
  it('creates one parent per day × project with the sub-task count', () => {
    const d = makeDraft({ items: [
      makeItem({ day: '2026-10-05', project: 'Boxsy' }),
      makeItem({ day: '2026-10-05', project: 'Boxsy' }),
      makeItem({ day: '2026-10-05', project: 'Dev - Internal' }),
      makeItem({ day: '2026-10-06', project: 'Boxsy', deleted: true }),
    ] });
    syncParents(d, [{ key: '2026-10-05|Boxsy', title: 'Monday — Prefill polish', description: '## 2026-10-05\n\nPolished the prefill flow.' }]);
    expect(d.parents.map(p => p.key)).toEqual(['2026-10-05|Boxsy', '2026-10-05|Dev - Internal']);
    expect(d.parents[0]).toMatchObject({ title: 'Monday — Prefill polish', description: '## 2026-10-05\n\nPolished the prefill flow.\n\n2 sub-tasks.' });
    expect(d.parents[1].title).toBe('Monday — Dev - Internal');
    expect(d.parents[1].description).toBe('## 2026-10-05\n\n1 sub-task.');
  });

  it('keeps edited parent text, updates counts, and keeps pushed parents', () => {
    const d = makeDraft({
      items: [makeItem({ day: '2026-10-05' })],
      parents: [
        { key: '2026-10-05|Boxsy', title: 'Mine', description: '## 2026-10-05\n\nMy words.\n\n4 sub-tasks.', edited: true, linear: null },
        { key: '2026-10-07|Boxsy', title: 'Pushed', description: 'x', edited: false, linear: { uuid: 'u', identifier: 'T-1', url: null, created: true } },
      ],
    });
    syncParents(d, [{ key: '2026-10-05|Boxsy', title: 'Ignored', description: 'Ignored' }]);
    expect(d.parents[0]).toMatchObject({ title: 'Mine', description: '## 2026-10-05\n\nMy words.\n\n1 sub-task.' });
    expect(d.parents.map(p => p.key)).toContain('2026-10-07|Boxsy');
  });

  it('withCount replaces or appends', () => {
    expect(withCount('## d\n\n3 sub-tasks.', 5)).toBe('## d\n\n5 sub-tasks.');
    expect(withCount('## d', 1)).toBe('## d\n\n1 sub-task.');
  });
});
