import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome } from './helpers.js';
import { secretStore } from '../src/lib/keychain.js';
import { paths } from '../src/lib/paths.js';

describe('secretStore (file backend)', () => {
  beforeEach(() => { tmpHome(); });
  it('stores secrets in a 0600 file', () => {
    const s = secretStore();
    expect(s.get('linear')).toBeNull();
    s.set('linear', 'lin_api_123');
    expect(s.get('linear')).toBe('lin_api_123');
    expect(fs.statSync(paths.secrets()).mode & 0o777).toBe(0o600);
    s.remove('linear');
    expect(s.get('linear')).toBeNull();
  });
});
