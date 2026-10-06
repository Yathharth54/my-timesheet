import { emptyDraft, loadDraft, requireConfig } from '../../lib/store.js';
import { resolveWeek } from '../../lib/week.js';
import { validate } from '../../lib/validate.js';
import { weekSummary } from '../out.js';

export function status(weekArg?: string): void {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  const d = loadDraft(week) ?? emptyDraft(week);
  console.log(weekSummary(d));
  const blocks = validate(d, config.projects.map(p => p.name)).filter(w => w.level === 'block');
  if (blocks.length) console.log(`${blocks.length} blocking issue${blocks.length === 1 ? '' : 's'} · run: timesheet review`);
}
