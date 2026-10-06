import { MAX_ITEM_HOURS } from './distribute.js';
import type { Draft, Warning } from './types.js';

export const HOURS_IN_TEXT = /\b\d+(?:\.\d+)?\s?(?:h|hrs?|hours?)\b/i;

export function validate(draft: Draft, projectNames: string[]): Warning[] {
  const w: Warning[] = [];
  const live = draft.items.filter(i => !i.deleted);
  if (!live.length) w.push({ level: 'warn', code: 'no_items', message: 'No items yet. Run /timesheet in Claude to draft this week.' });
  if (draft.totalHours == null) w.push({ level: 'block', code: 'total_missing', message: 'Enter the total hours for the week.' });
  for (const i of live) {
    if (i.linear?.created) continue;
    if (!i.project) w.push({ level: 'block', code: 'no_project', message: `"${i.title}" has no project.`, itemId: i.id });
    else if (!projectNames.includes(i.project)) w.push({ level: 'block', code: 'unknown_project', message: `"${i.title}" uses unknown project "${i.project}".`, itemId: i.id });
    if (i.hours == null) w.push({ level: 'block', code: 'no_hours', message: `"${i.title}" has no hours. Press Distribute.`, itemId: i.id });
    else if (i.hours > MAX_ITEM_HOURS) w.push({ level: 'block', code: 'over_cap', message: `"${i.title}" is ${i.hours}h; the limit is ${MAX_ITEM_HOURS}h per sub-issue.`, itemId: i.id });
    if (!draft.days.includes(i.day)) w.push({ level: 'block', code: 'day_not_counted', message: `"${i.title}" is on ${i.day}, which isn't a counted day.`, itemId: i.id });
    if (HOURS_IN_TEXT.test(i.title) || HOURS_IN_TEXT.test(i.description)) w.push({ level: 'warn', code: 'hours_in_text', message: `"${i.title}" mentions hours in its text.`, itemId: i.id });
  }
  if (draft.totalHours != null && live.length && live.every(i => i.hours != null)) {
    const sum = Math.round(live.reduce((s, i) => s + (i.hours ?? 0), 0) * 1e6) / 1e6;
    if (Math.abs(sum - draft.totalHours) > 1e-9) w.push({ level: 'block', code: 'total_mismatch', message: `Items add up to ${sum}h but the total is ${draft.totalHours}h.` });
    if (draft.totalHours < 45) w.push({ level: 'warn', code: 'week_under_45', message: `${draft.totalHours}h is under 45h. Is some work missing?` });
  }
  return w;
}
