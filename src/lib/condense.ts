import fs from 'node:fs';
import { localDate } from './week.js';
import type { Digest } from './types.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_PROMPTS = 40;
const MAX_FILES = 60;
const MAX_COMMANDS = 30;
const MAX_REPLIES = 15;

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function condense(file: string, session: string, from: Date, to: Date): Digest {
  const digest: Digest = { session, transcript: file, missing: false, prompts: [], filesEdited: [], commands: [], replies: [], days: {} };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...digest, missing: true };
  }
  const files = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o?.timestamp !== 'string') continue;
    const ts = new Date(o.timestamp);
    if (Number.isNaN(ts.getTime()) || ts < from || ts >= to) continue;
    const content = o.message?.content;
    if (o.type === 'user' && !o.isMeta && typeof content === 'string' && !content.trimStart().startsWith('<')) {
      if (digest.prompts.length < MAX_PROMPTS) digest.prompts.push(clip(content, 300));
      const day = localDate(ts);
      const a = (digest.days[day] ??= { turns: 0, first: o.timestamp, last: o.timestamp });
      a.turns += 1;
      if (o.timestamp < a.first) a.first = o.timestamp;
      if (o.timestamp > a.last) a.last = o.timestamp;
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const fp = b.input?.file_path ?? b.input?.notebook_path;
          if (EDIT_TOOLS.has(b.name) && typeof fp === 'string') files.add(fp);
          if (b.name === 'Bash' && typeof b.input?.command === 'string' && digest.commands.length < MAX_COMMANDS) {
            digest.commands.push(clip(b.input.command.split('\n')[0], 160));
          }
        } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length >= 40) {
          digest.replies.push(clip(b.text, 300));
          if (digest.replies.length > MAX_REPLIES) digest.replies.shift();
        }
      }
    }
  }
  digest.filesEdited = [...files].slice(0, MAX_FILES);
  return digest;
}
