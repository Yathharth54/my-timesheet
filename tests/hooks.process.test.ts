import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig } from '../src/lib/store.js';
import { paths } from '../src/lib/paths.js';

const runHook = (name: string, stdin: string) =>
  spawnSync('node', [path.resolve('dist/hooks', `${name}.js`)], { input: stdin, env: { ...process.env }, encoding: 'utf8' });

describe('hook processes', () => {
  beforeAll(() => { execSync('npm run build', { stdio: 'ignore' }); });
  beforeEach(() => { tmpHome(); saveConfig(testConfig()); });

  it('exits 0 and writes nothing for a deleted cwd with spaces', () => {
    const cwd = path.join(tmpDir(), 'gone folder', 'sub dir');
    const r = runHook('stop', JSON.stringify({ cwd, session_id: 's', transcript_path: '/t.jsonl' }));
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.dirname(paths.log('2026-W41')))).toBe(false);
  });

  it('exits 0 on garbage stdin and records the error', () => {
    const r = runHook('session-start', 'not json');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(paths.hookErrors(), 'utf8')).toMatch(/session-start/);
  });

  it('prints additionalContext JSON for an unknown folder', () => {
    const r = runHook('session-start', JSON.stringify({ cwd: tmpDir() }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});
