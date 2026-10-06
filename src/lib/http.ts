export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function request(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<{ status: number; json: any }> {
  const { retries = 5, baseMs = 500, sleep: wait = sleep, fetchImpl = fetch } = opts;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      if (attempt >= retries) throw e;
      await wait(baseMs * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, await res.text());
      const ra = Number(res.headers.get('retry-after'));
      await wait(Number.isFinite(ra) && ra > 0 ? ra * 1000 : baseMs * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) throw new HttpError(res.status, text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}
