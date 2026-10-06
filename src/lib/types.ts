export type RepoClass = 'work' | 'personal' | 'ignore';
export interface RepoEntry { class: RepoClass; project?: string; name?: string }
/** key: absolute repo root (or folder path when not a git repo) */
export type Repos = Record<string, RepoEntry>;

export type ProjectKind = 'billable' | 'internal';
export interface ProjectConfig { id: string; name: string; teamId: string; kind: ProjectKind; stateId: string; labelIds: string[] }

export interface Config {
  version: 1;
  linear: { assigneeId: string; assigneeEmail: string };
  everhour: { userId: number };
  projects: ProjectConfig[];
  internalProject: string;
  workOrgs: string[];
  gitEmails: string[];
  nudge: boolean;
  port: number;
}

export interface LogEntry { t: string; session: string; root: string; repo: string; project: string | null; transcript: string }

export interface Evidence { commits: string[]; sessions: string[]; manual: boolean }
export interface LinearRef { uuid: string; identifier: string | null; url: string | null; created: boolean }

export interface Item {
  id: string;
  title: string;
  description: string;
  project: string | null;
  bucketReason: string;
  day: string;
  evidence: Evidence;
  weight: number | null;
  weightReason: string | null;
  hours: number | null;
  locked: boolean;
  edited: boolean;
  deleted: boolean;
  linear: LinearRef | null;
  everhour: { logged: boolean } | null;
}

export interface Parent { key: string; title: string; description: string; edited: boolean; linear: LinearRef | null }

export interface Draft {
  week: string;
  rev: number;
  totalHours: number | null;
  days: string[];
  weightsSource: 'claude' | 'heuristic' | null;
  pushed: boolean;
  items: Item[];
  parents: Parent[];
}

export interface Warning { level: 'block' | 'warn'; code: string; message: string; itemId?: string }

export interface DayActivity { turns: number; first: string; last: string }
export interface Digest {
  session: string; transcript: string; missing: boolean;
  prompts: string[]; filesEdited: string[]; commands: string[]; replies: string[];
  days: Record<string, DayActivity>;
}

export interface Commit {
  sha: string; root: string; repo: string; at: string; day: string;
  subject: string; files: string[]; insertions: number; deletions: number;
}

export interface SessionEvidence { repo: string; project: string | null; prompts: number; days: Record<string, DayActivity> }
export interface WeekEvidence { commits: Record<string, Commit>; sessions: Record<string, SessionEvidence> }

export interface ProposedItem {
  id?: string; title: string; description: string; project: string | null; bucketReason: string; day: string;
  evidence: { commits: string[]; sessions: string[] };
}
export interface ProposedParent { key: string; title: string; description: string }
export interface Proposal { items: ProposedItem[]; parents?: ProposedParent[] }
