import pc from 'picocolors';
import { prepare } from '../../lib/draftflow.js';
import { resolveWeek } from '../../lib/week.js';
import { step } from '../out.js';

export async function prepareCmd(weekArg?: string): Promise<void> {
  const week = resolveWeek(weekArg);
  const r = await step(`Collecting ${week}`, async () => prepare(week), x => `Collected ${x.sessions} sessions, ${x.commits} commits`);
  for (const w of r.warnings) console.log(`${pc.yellow('!')} ${w}`);
  console.log(r.contextPath);
}
