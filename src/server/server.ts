import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../lib/paths.js';
import { appendLine, emptyDraft, listWeeks, loadDraft, loadRepos, readJson, requireConfig, saveConfig, saveDraft, saveRepos } from '../lib/store.js';
import { resolveWeek, weekDays } from '../lib/week.js';
import { validate } from '../lib/validate.js';
import { syncParents } from '../lib/parents.js';
import { runClaude, runDistribute, type ClaudeRunner } from '../lib/weights.js';
import { addManualItem, deleteItem, mechanicalSplit, mergeItems, setHours, splitItem } from '../lib/edit.js';
import { push } from '../lib/push.js';
import { acquireWeekLock } from '../lib/lock.js';
import type { LinearApi } from '../lib/linear.js';
import type { EverhourApi } from '../lib/everhour.js';
import type { Draft, RepoClass, Warning, WeekEvidence } from '../lib/types.js';
import { clientsFromSecrets } from '../cli/commands/push.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

type Clients = { linear: LinearApi; everhour: EverhourApi & { userSeconds(id: number, from: string, to: string): Promise<number> } };
export interface ServerDeps { run?: ClaudeRunner; clients?: () => Clients; now?: () => Date }
type PushState = { status: 'idle' | 'running' | 'blocked' | 'awaiting_sync' | 'done' | 'error'; phase?: string; done?: number; total?: number; missing?: { identifier: string; project: string }[]; warnings?: Warning[]; error?: string };

class ApiError extends Error {
  constructor(public status: number, message: string, public payload: Record<string, unknown> = {}) { super(message); }
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new ApiError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new ApiError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function createServer(deps: ServerDeps = {}): http.Server {
  const run = deps.run ?? runClaude;
  const clients = deps.clients ?? clientsFromSecrets;
  const now = deps.now ?? (() => new Date());
  const pushStates = new Map<string, PushState>();
  const ehCache = new Map<string, { at: number; hours: number | null }>();

  const projectNames = () => requireConfig().projects.map(p => p.name);
  const current = (week: string): Draft => loadDraft(week) ?? emptyDraft(week);
  const respond = (d: Draft) => ({ draft: d, warnings: validate(d, projectNames()) });
  const commit = (d: Draft) => respond(saveDraft(syncParents(d)));
  const assertNotPushing = (week: string) => {
    if (pushStates.get(week)?.status === 'running') throw new ApiError(423, 'A push is running for this week. Wait for it to finish.');
  };
  const busy = (e: unknown) => new ApiError(423, (e as Error).message);
  const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { throw e instanceof ApiError ? e : new ApiError(400, (e as Error).message); } };

  function putDraft(incoming: Draft) {
    if (!incoming?.week) throw new ApiError(400, 'Missing draft');
    const cur = current(incoming.week);
    if (incoming.rev !== cur.rev) throw new ApiError(409, 'The draft changed elsewhere. Reloaded.', { draft: cur });
    assertNotPushing(incoming.week);
    incoming.pushed = cur.pushed;
    incoming.weightsSource = cur.weightsSource;
    const before = new Map(cur.items.map(i => [i.id, i]));
    incoming.items = incoming.items.map(i => {
      const old = before.get(i.id);
      if (!old) return i;
      if (old.linear?.created) return old;
      if (old.linear) i.linear = old.linear;
      if (old.project !== i.project) appendLine(paths.examples(), { kind: 'bucket', title: i.title, description: i.description, from: old.project, to: i.project, at: new Date().toISOString() });
      if (old.title !== i.title || old.description !== i.description) {
        appendLine(paths.examples(), { kind: 'rewrite', before: { title: old.title, description: old.description }, after: { title: i.title, description: i.description }, at: new Date().toISOString() });
        i.edited = true;
      }
      return i;
    });
    const have = new Set(incoming.items.map(i => i.id));
    for (const old of cur.items) if (old.linear?.created && !have.has(old.id)) incoming.items.push(old);
    for (const p of incoming.parents) {
      const old = cur.parents.find(x => x.key === p.key);
      if (old?.linear?.created) Object.assign(p, old);
      else if (old) {
        if (old.linear) p.linear = old.linear;
        if (old.title !== p.title || old.description !== p.description) p.edited = true;
      }
    }
    const haveP = new Set(incoming.parents.map(p => p.key));
    for (const old of cur.parents) if (old.linear?.created && !haveP.has(old.key)) incoming.parents.push(old);
    return commit(incoming);
  }

  async function everhourHours(week: string): Promise<number | null> {
    const hit = ehCache.get(week);
    if (hit && Date.now() - hit.at < 60_000) return hit.hours;
    let hours: number | null = null;
    try {
      const days = weekDays(week);
      hours = (await clients().everhour.userSeconds(requireConfig().everhour.userId, days[0], days[6])) / 3600;
    } catch { hours = null; }
    ehCache.set(week, { at: Date.now(), hours });
    return hours;
  }

  function startPush(week: string) {
    if (pushStates.get(week)?.status === 'running') throw new ApiError(409, 'A push is already running.');
    let release: () => void;
    try { release = acquireWeekLock(week); } catch (e) { throw busy(e); }
    pushStates.set(week, { status: 'running', phase: 'parents', done: 0, total: 0 });
    void (async () => {
      try {
        const draft = loadDraft(week);
        if (!draft) throw new Error('No draft for this week.');
        const { linear, everhour } = clients();
        const r = await push(draft, { linear, everhour, config: requireConfig(), save: saveDraft, onProgress: e => pushStates.set(week, { status: 'running', ...e }) });
        if (r.status === 'done') pushStates.set(week, { status: 'done' });
        else if (r.status === 'blocked') pushStates.set(week, { status: 'blocked', warnings: r.warnings });
        else pushStates.set(week, { status: 'awaiting_sync', missing: r.missing });
        ehCache.delete(week);
      } catch (e) {
        pushStates.set(week, { status: 'error', error: (e as Error).message });
      } finally {
        release();
      }
    })();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port;
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'Forbidden host' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: 'Forbidden origin' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Expected application/json' });
      }
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(PUBLIC, file)));
      }
      const week = resolveWeek(url.searchParams.get('week') ?? undefined, now());
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/state': {
          const config = requireConfig();
          const d = current(week);
          return send(res, 200, {
            week, draft: d, weeks: [...new Set([week, ...listWeeks()])].sort().reverse(),
            projects: config.projects.map(({ name, kind }) => ({ name, kind })),
            warnings: validate(d, projectNames()), push: pushStates.get(week) ?? { status: 'idle' },
          });
        }
        case 'GET /api/rev': return send(res, 200, { rev: loadDraft(week)?.rev ?? 0 });
        case 'PUT /api/draft': { const b = await readBody(req); return send(res, 200, wrap(() => putDraft(b.draft))); }
        case 'POST /api/distribute': {
          const b = await readBody(req);
          const w = resolveWeek(b.week, now());
          assertNotPushing(w);
          const evidence = readJson<WeekEvidence>(paths.evidence(w), { commits: {}, sessions: {} });
          let release: () => void;
          try { release = acquireWeekLock(w); } catch (e) { throw busy(e); }
          try {
            const before = current(w);
            let out: Draft;
            try { out = await runDistribute(before, { reweight: !!b.reweight }, { run, evidence }); } catch (e) { throw new ApiError(400, (e as Error).message); }
            const latest = current(w);
            if (latest.rev !== before.rev) throw new ApiError(409, 'The draft changed while weights were computed. Run Distribute again.', { draft: latest });
            return send(res, 200, commit(out));
          } finally { release(); }
        }
        case 'POST /api/hours': { const b = await readBody(req); return send(res, 200, wrap(() => { assertNotPushing(resolveWeek(b.week, now())); return commit(setHours(current(resolveWeek(b.week, now())), b.id, Number(b.hours))); })); }
        case 'POST /api/items': { const b = await readBody(req); return send(res, 200, wrap(() => { assertNotPushing(resolveWeek(b.week, now())); return commit(addManualItem(current(resolveWeek(b.week, now())), b)); })); }
        case 'POST /api/delete': { const b = await readBody(req); return send(res, 200, wrap(() => { assertNotPushing(resolveWeek(b.week, now())); return commit(deleteItem(current(resolveWeek(b.week, now())), b.id)); })); }
        case 'POST /api/split': {
          const b = await readBody(req);
          return send(res, 200, wrap(() => {
            assertNotPushing(resolveWeek(b.week, now()));
            const d = current(resolveWeek(b.week, now()));
            const item = d.items.find(i => i.id === b.id);
            if (!item) throw new Error(`No item ${b.id}.`);
            return commit(splitItem(d, b.id, mechanicalSplit(item, Math.max(2, Number(b.parts) || 2))));
          }));
        }
        case 'POST /api/merge': { const b = await readBody(req); return send(res, 200, wrap(() => { assertNotPushing(resolveWeek(b.week, now())); return commit(mergeItems(current(resolveWeek(b.week, now())), b.ids)); })); }
        case 'GET /api/everhour': return send(res, 200, { hours: await everhourHours(week) });
        case 'GET /api/history': return send(res, 200, listWeeks().flatMap(w => {
          const d = loadDraft(w);
          if (!d) return [];
          const live = d.items.filter(i => !i.deleted);
          const byProject: Record<string, number> = {};
          for (const i of live) if (i.project && i.hours != null) byProject[i.project] = (byProject[i.project] ?? 0) + i.hours;
          return [{ week: w, total: live.reduce((s, i) => s + (i.hours ?? 0), 0), items: live.length, pushed: d.pushed, byProject }];
        }));
        case 'GET /api/settings': {
          const c = requireConfig();
          return send(res, 200, {
            projects: c.projects.map(({ name, kind }) => ({ name, kind })), workOrgs: c.workOrgs, nudge: c.nudge,
            repos: Object.entries(loadRepos()).map(([root, e]) => ({ root, ...e })),
          });
        }
        case 'PUT /api/settings': {
          const b = await readBody(req);
          const c = requireConfig();
          for (const p of c.projects) { const k = b.projects?.find((x: { name: string }) => x.name === p.name)?.kind; if (k === 'billable' || k === 'internal') p.kind = k; }
          if (Array.isArray(b.workOrgs)) c.workOrgs = b.workOrgs.map(String);
          if (typeof b.nudge === 'boolean') c.nudge = b.nudge;
          saveConfig(c);
          if (Array.isArray(b.repos)) {
            const repos = loadRepos();
            for (const r of b.repos as { root: string; class: RepoClass; project?: string }[]) {
              if (!repos[r.root] || !['work', 'personal', 'ignore'].includes(r.class)) continue;
              repos[r.root] = { ...repos[r.root], class: r.class, project: r.class === 'work' ? r.project : undefined };
            }
            saveRepos(repos);
          }
          return send(res, 200, { ok: true });
        }
        case 'POST /api/push': {
          const b = await readBody(req);
          const w = resolveWeek(b.week, now());
          if (b.confirm !== true && !loadDraft(w)?.pushed) {
            const hours = await everhourHours(w);
            if (hours === null || hours > 0) throw new ApiError(409, hours === null ? "Couldn't read this week's Everhour total. Confirm to push anyway." : `Everhour already has ${hours}h for ${w}. Confirm to push anyway.`, { needsConfirm: true, hours });
          }
          startPush(w);
          return send(res, 202, { started: true });
        }
        case 'GET /api/push': return send(res, 200, pushStates.get(week) ?? { status: 'idle' });
        default: return send(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, (e as Error).message);
      send(res, err.status, { error: err.message, ...err.payload });
    }
  });
  return server;
}

export function startServer(port: number, deps: ServerDeps = {}): Promise<{ url: string; server: http.Server; close(): Promise<void> }> {
  const server = createServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${p}`, server, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}
