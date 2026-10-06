import { describe, it, expect } from 'vitest';
import { Linear } from '../src/lib/linear.js';

function fakeFetch(reply: (body: any) => unknown) {
  const calls: { headers: any; body: any }[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ headers: init.headers, body });
    return new Response(JSON.stringify(reply(body)), { status: 200 });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe('Linear', () => {
  it('sends the raw API key and creates issues with a client id', async () => {
    const f = fakeFetch(() => ({ data: { issueCreate: { success: true, issue: { id: 'uuid-1', identifier: 'THE-1', url: 'https://linear.app/t/THE-1' } } } }));
    const l = new Linear('lin_api_x', { fetchImpl: f.fetchImpl });
    const ref = await l.createIssue({ id: 'uuid-1', teamId: 't', projectId: 'p', assigneeId: 'a', stateId: 's', labelIds: [], title: 'T', description: 'D' });
    expect(ref).toEqual({ uuid: 'uuid-1', identifier: 'THE-1', url: 'https://linear.app/t/THE-1' });
    expect(f.calls[0].headers.Authorization).toBe('lin_api_x');
    expect(f.calls[0].body.variables.input).toMatchObject({ id: 'uuid-1', teamId: 't', title: 'T' });
    expect(f.calls[0].body.variables.input).not.toHaveProperty('parentId');
  });

  it('getIssue returns null for missing issues and throws other GraphQL errors', async () => {
    const missing = new Linear('k', { fetchImpl: fakeFetch(() => ({ errors: [{ message: 'Entity not found: Issue' }] })).fetchImpl });
    expect(await missing.getIssue('nope')).toBeNull();
    const broken = new Linear('k', { fetchImpl: fakeFetch(() => ({ errors: [{ message: 'Authentication required' }] })).fetchImpl });
    await expect(broken.viewer()).rejects.toThrow(/Authentication required/);
  });
});
