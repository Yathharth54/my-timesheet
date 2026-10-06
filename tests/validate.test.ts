import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { validate } from '../src/lib/validate.js';

const names = ['Boxsy', 'Dev - Internal'];
const codes = (d: ReturnType<typeof makeDraft>) => validate(d, names).map(w => `${w.level}:${w.code}`);

describe('validate', () => {
  it('blocks every unsafe state', () => {
    const d = makeDraft({ totalHours: 10, items: [
      makeItem({ id: 'a', project: null, hours: 2 }),
      makeItem({ id: 'b', project: 'Nope', hours: 4 }),
      makeItem({ id: 'c', hours: 1, day: '2026-10-11' }),
    ] });
    expect(codes(d)).toEqual(expect.arrayContaining([
      'block:no_project', 'block:unknown_project', 'block:over_cap', 'block:day_not_counted', 'block:total_mismatch', 'warn:week_under_45',
    ]));
  });

  it('flags missing total and missing hours, and warns about hours written in text', () => {
    const d = makeDraft({ items: [makeItem({ title: 'Audit (2h)', hours: null })] });
    expect(codes(d)).toEqual(expect.arrayContaining(['block:total_missing', 'block:no_hours', 'warn:hours_in_text']));
  });

  it('is clean for a good week and ignores pushed items for per-item checks', () => {
    const items = Array.from({ length: 16 }, (_, i) => makeItem({ hours: 3 }));
    items.push(makeItem({ hours: 2, day: '2026-10-11', linear: { uuid: 'u', identifier: 'T', url: null, created: true } }));
    expect(validate(makeDraft({ totalHours: 50, items }), names)).toEqual([]);
  });
});
