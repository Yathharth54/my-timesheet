import { request, type RetryOpts } from './http.js';

const ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearIssueRef { uuid: string; identifier: string; url: string }
export interface CreateIssueInput {
  id: string; teamId: string; projectId: string; assigneeId: string; stateId: string; labelIds: string[];
  parentId?: string; title: string; description: string;
}

export class Linear {
  constructor(private apiKey: string, private opts: RetryOpts = {}) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { json } = await request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    }, this.opts);
    if (json?.errors?.length) throw new Error(`Linear: ${json.errors.map((e: { message: string }) => e.message).join('; ')}`);
    return json.data as T;
  }

  async viewer(): Promise<{ id: string; email: string; name: string }> {
    return (await this.gql<{ viewer: { id: string; email: string; name: string } }>('query { viewer { id email name } }')).viewer;
  }

  async projects(): Promise<{ id: string; name: string; teams: { id: string; name: string; key: string }[] }[]> {
    const d = await this.gql<any>('query { projects(first: 250) { nodes { id name teams { nodes { id name key } } } } }');
    return d.projects.nodes.map((p: any) => ({ id: p.id, name: p.name, teams: p.teams.nodes }));
  }

  async states(teamId: string): Promise<{ id: string; name: string; type: string }[]> {
    const d = await this.gql<any>('query($id: String!) { team(id: $id) { states { nodes { id name type } } } }', { id: teamId });
    return d.team.states.nodes;
  }

  async getIssue(id: string): Promise<LinearIssueRef | null> {
    try {
      const d = await this.gql<any>('query($id: String!) { issue(id: $id) { id identifier url } }', { id });
      return d.issue ? { uuid: d.issue.id, identifier: d.issue.identifier, url: d.issue.url } : null;
    } catch (e) {
      if (/not found/i.test((e as Error).message)) return null;
      throw e;
    }
  }

  async createIssue(input: CreateIssueInput): Promise<LinearIssueRef> {
    const d = await this.gql<any>(
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
      { input },
    );
    if (!d.issueCreate?.success) throw new Error('Linear: issueCreate returned success=false');
    const i = d.issueCreate.issue;
    return { uuid: i.id, identifier: i.identifier, url: i.url };
  }

  async deleteIssue(id: string): Promise<void> {
    await this.gql('mutation($id: String!) { issueDelete(id: $id) { success } }', { id });
  }
}

export type LinearApi = Pick<Linear, 'getIssue' | 'createIssue'>;
