import { ingest } from '../../lib/draftflow.js';
import { resolveWeek } from '../../lib/week.js';
import { step } from '../out.js';

export async function ingestCmd(weekArg?: string): Promise<void> {
  const week = resolveWeek(weekArg);
  await step(`Merging ${week}`, async () => ingest(week), r => `Merged ${r.added} new, ${r.updated} updated, ${r.skipped} skipped · ${r.items} items in ${week}`);
}
