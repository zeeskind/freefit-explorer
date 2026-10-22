import { config } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.body = body.slice(0, 500);
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * GET a URL and return { status, headers, text, url }.
 * Retries network errors and retryable statuses with exponential backoff.
 * Non-2xx responses throw HttpError unless allowStatus includes the status.
 */
export async function request(url, opts = {}) {
  const {
    retries = 3,
    timeoutMs = config.requestTimeoutMs,
    headers = {},
    allowStatus = [],
    accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': config.userAgent,
          Accept: accept,
          'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
          ...headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.ok || allowStatus.includes(res.status)) {
        return { status: res.status, headers: res.headers, text, url: res.url };
      }
      lastErr = new HttpError(res.status, url, text);
      if (!RETRYABLE.has(res.status)) throw lastErr;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE.has(err.status)) throw err;
      lastErr = err;
      if (attempt < retries) await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const res = await request(url, { accept: 'application/json', ...opts });
  try {
    return { ...res, json: JSON.parse(res.text) };
  } catch {
    throw new Error(`Expected JSON from ${url} but got: ${res.text.slice(0, 120)}`);
  }
}

function backoff(attempt) {
  return Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
}

/** Run async jobs with bounded concurrency and an optional delay between starts. */
export function createLimiter(concurrency, delayMs = 0) {
  let active = 0;
  const queue = [];
  let lastStart = 0;

  const next = async () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    const wait = Math.max(0, lastStart + delayMs - Date.now());
    if (wait) await sleep(wait);
    lastStart = Date.now();
    try {
      resolve(await fn());
    } catch (e) {
      reject(e);
    } finally {
      active--;
      next();
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
