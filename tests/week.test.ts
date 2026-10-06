import { describe, it, expect } from 'vitest';
import { isoWeek, weekDays, shiftWeek, weekdayName, resolveWeek, weekOfDate, localDate } from '../src/lib/week.js';

describe('week helpers', () => {
  it('computes ISO weeks', () => {
    expect(isoWeek(new Date(2026, 9, 6))).toBe('2026-W41');
    expect(isoWeek(new Date(2026, 8, 28))).toBe('2026-W40');
    expect(isoWeek(new Date(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(new Date(2025, 11, 29))).toBe('2026-W01');
  });
  it('lists Monday..Sunday', () => {
    expect(weekDays('2026-W41')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  });
  it('shifts weeks across years', () => {
    expect(shiftWeek('2026-W41', -1)).toBe('2026-W40');
    expect(shiftWeek('2026-W53', 1)).toBe('2027-W01');
  });
  it('names weekdays and resolves arguments', () => {
    expect(weekdayName('2026-10-05')).toBe('Monday');
    const now = new Date(2026, 9, 6, 10);
    expect(resolveWeek(undefined, now)).toBe('2026-W41');
    expect(resolveWeek('last', now)).toBe('2026-W40');
    expect(resolveWeek('2026-W30', now)).toBe('2026-W30');
    expect(() => resolveWeek('yesterday', now)).toThrow(/Unrecognised week/);
    expect(weekOfDate('2026-10-11')).toBe('2026-W41');
    expect(localDate(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });
});
