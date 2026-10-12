import { weekDays, weekdayName } from './week.js';
import type { Op } from './ops.js';
import type { Config, Draft } from './types.js';

export interface Turn { message: string; reply: string }

/** The prompt for Ask Claude in the review tab: the whole live week, the op format and the rules. */
export function assistPrompt(draft: Draft, config: Pick<Config, 'projects' | 'internalProject'>, message: string, history: Turn[] = []): string {
  const issues = draft.items.filter(i => !i.deleted).map(i => ({
    id: i.id, title: i.title, description: i.description, project: i.project, day: i.day, weekday: weekdayName(i.day),
    hours: i.hours, locked: i.locked, inLinear: i.linear ? (i.linear.identifier ?? true) : false,
    ...(i.sameAs ? { sameIssueAs: i.sameAs } : {}),
  }));
  return [
    'You help someone tidy one week of their timesheet in a review screen. Each issue becomes a Linear sub-issue with hours in Everhour.',
    'You can only change the week by returning ops. Available ops:',
    '  {"op":"set","ids":["..."],"project":"<project name>"}   (project and/or "day":"YYYY-MM-DD"; "title" or "description" only with one id)',
    '  {"op":"hours","id":"...","hours":1.5}',
    '  {"op":"merge","ids":["first","second",...]}   (all merge into the first)',
    '  {"op":"delete","ids":["..."]}',
    '  {"op":"copy","ids":["..."],"days":["YYYY-MM-DD",...],"hours":1}   (logs the same issue on more days; hours is optional and defaults to the issue\'s own)',
    'Rules:',
    '- Use only ids listed below. Never invent ids, projects or days.',
    '- Issues with inLinear set are already in Linear: only delete works on them. Deleting one also removes it from Linear and its hours from Everhour, and the person confirms that separately.',
    '- Recurring work (a standup, a team sync, a client call) is one issue logged on several days: use copy, never add new issues for it. Issues with sameIssueAs are other days of the issue with that id. Title, description and project are shared by every day of it; hours and day are per day. Copy only to counted days, and never to a day the issue already has.',
    '- Titles are 2 to 3 words. Never put hours or durations in a title or description.',
    '- If the request is unclear or impossible, return no ops and say why in the reply.',
    '- In the reply, name issues by title (and Linear identifier if it has one), never by id.',
    'Reply with ONLY a JSON object: {"reply":"one or two plain sentences on what you will change","ops":[...]}',
    '',
    `Week ${draft.week}. Days: ${weekDays(draft.week).map(d => `${weekdayName(d)} ${d}`).join(', ')}. Counted days: ${draft.days.join(', ') || 'none'}.`,
    `Projects: ${config.projects.map(p => `${p.name} (${p.kind})`).join(', ')}. The internal project is ${config.internalProject}.`,
    `Total hours worked: ${draft.totalHours ?? 'not set'}.`,
    'Issues:',
    JSON.stringify(issues, null, 1),
    ...(history.length ? ['', 'Earlier in this conversation:', ...history.flatMap(t => [`Person: ${t.message}`, `You: ${t.reply}`])] : []),
    '',
    `Person: ${message}`,
  ].join('\n');
}

export function parseAssist(text: string): { reply: string; ops: Op[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error("Claude didn't return any changes. Try saying it another way.");
  let v: any;
  try { v = JSON.parse(body.slice(start, end + 1)); } catch { throw new Error("Claude's answer couldn't be read. Try again."); }
  return { reply: typeof v.reply === 'string' ? v.reply : '', ops: Array.isArray(v.ops) ? v.ops : [] };
}
