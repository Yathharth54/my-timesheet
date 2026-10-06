import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, tmpHome } from './helpers.js';
import { installHooks, uninstallHooks, hooksInstalled, installSkillFiles, uninstallSkillFiles, claudeDir } from '../src/lib/install.js';

const existing = {
  theme: 'dark',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "/Users/y/.selflore/app/hooks/session-start.js"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node "/Users/y/.selflore/app/hooks/stop.js"' }] }],
  },
};

describe('install', () => {
  let pkg: string;
  beforeEach(() => {
    tmpHome();
    pkg = path.join(tmpDir(), 'timesheet skill');
    fs.mkdirSync(path.join(pkg, 'skill', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'skill', 'SKILL.md'), '---\nname: timesheet\n---\n');
    fs.writeFileSync(path.join(pkg, 'skill', 'commands', 'timesheet.md'), 'cmd');
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(path.join(claudeDir(), 'settings.json'), JSON.stringify(existing));
  });

  it('adds quoted, marked hooks once and keeps everything else', () => {
    installHooks(pkg);
    installHooks(pkg);
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8'));
    expect(s.theme).toBe('dark');
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(s.hooks.Stop[1].hooks[0].command).toBe(`node "${path.join(pkg, 'dist', 'hooks', 'stop.js')}" # my-timesheet`);
    expect(hooksInstalled()).toBe(true);
  });

  it('uninstall restores the original settings exactly', () => {
    installHooks(pkg);
    uninstallHooks();
    expect(JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8'))).toEqual(existing);
    expect(hooksInstalled()).toBe(false);
  });

  it('copies and removes the skill and command files', () => {
    const files = installSkillFiles(pkg);
    expect(files.every(f => fs.existsSync(f))).toBe(true);
    uninstallSkillFiles();
    expect(files.some(f => fs.existsSync(f))).toBe(false);
  });
});
