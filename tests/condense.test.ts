import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { condense } from '../src/lib/condense.js';

const write = (lines: unknown[]): string => {
  const f = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(f, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return f;
};
const user = (t: string, content: string, extra = {}) => ({ type: 'user', timestamp: t, message: { role: 'user', content }, ...extra });
const asst = (t: string, blocks: unknown[]) => ({ type: 'assistant', timestamp: t, message: { role: 'assistant', content: blocks } });
const from = new Date('2026-10-05T00:00:00Z');
const to = new Date('2026-10-12T00:00:00Z');

describe('condense', () => {
  const tz = process.env.TZ;
  afterEach(() => { process.env.TZ = tz; });

  it('keeps prompts, edited files, commands and long replies; skips meta, tags and junk', () => {
    const f = write([
      user('2026-10-05T09:00:00Z', 'build the prefill extract endpoint'),
      user('2026-10-05T09:00:01Z', 'skill text', { isMeta: true }),
      user('2026-10-05T09:00:02Z', '<command-name>/clear</command-name>'),
      '{this is not json',
      asst('2026-10-05T09:01:00Z', [
        { type: 'thinking', thinking: '' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/r/api/prefill.py' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/r/api/prefill.py' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'pytest tests/test_prefill.py -q\necho done' } },
        { type: 'text', text: 'ok' },
        { type: 'text', text: 'Added the extract endpoint with a 25 MB limit and MIME sniffing for PDF and PPTX.' },
      ]),
      { type: 'user', timestamp: '2026-10-05T09:02:00Z', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } },
      user('2026-09-30T09:00:00Z', 'last week prompt'),
    ]);
    const d = condense(f, 's1', from, to);
    expect(d.missing).toBe(false);
    expect(d.prompts).toEqual(['build the prefill extract endpoint']);
    expect(d.filesEdited).toEqual(['/r/api/prefill.py']);
    expect(d.commands).toEqual(['pytest tests/test_prefill.py -q']);
    expect(d.replies).toEqual(['Added the extract endpoint with a 25 MB limit and MIME sniffing for PDF and PPTX.']);
    expect(d.days).toEqual({ '2026-10-05': { turns: 1, first: '2026-10-05T09:00:00Z', last: '2026-10-05T09:00:00Z' } });
  });

  it('assigns turns to the local date (IST, near midnight UTC)', () => {
    process.env.TZ = 'Asia/Kolkata';
    const f = write([user('2026-10-05T19:00:00Z', 'late night work in India')]);
    const d = condense(f, 's1', new Date('2026-10-04T18:30:00Z'), new Date('2026-10-11T18:30:00Z'));
    expect(Object.keys(d.days)).toEqual(['2026-10-06']);
  });

  it('flags missing transcripts and clips long prompts', () => {
    expect(condense('/nope/x.jsonl', 's', from, to).missing).toBe(true);
    const f = write([user('2026-10-06T10:00:00Z', 'a'.repeat(1000))]);
    const p = condense(f, 's', from, to).prompts[0];
    expect(p.length).toBe(300);
    expect(p.endsWith('…')).toBe(true);
  });
});
