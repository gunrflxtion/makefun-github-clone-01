// app.ts — the forge's HTTP server: routing + auth + one shared Store.
//
// Wiring (see INTEGRATION.md for the contract the surface modules follow):
//   GET /healthz            -> 200 {"ok":true}, no auth
//   GET /api/v3[/]          -> 200 API root + x-oauth-scopes, no auth (starter behaviour)
//   /{owner}/{repo}.git/*   -> git.ts       (handleGit)
//   /api/v3/*               -> rest.ts      (handleRest; protocol.ts auth is done here)
//   /api/graphql[/]         -> graphql.ts   (handleGraphql)
//   /mcp[/]                 -> mcp.ts      (handleMcp)
//   everything else         -> 404 {"message":"Not Found"} JSON
//   (a surface whose module has not landed yet also answers 404 on the wire;
//   the missing import is logged to stderr only — never leak dev state).
// One Store instance per process, created once in createApp() (lazy dynamic
// import so the server still boots while a surface module is being written).
// Auth: every route except /healthz and the API root requires the exact bearer
// token from MAKEFUN_SHOP_TOKEN (read once at startup); missing/wrong -> 401
// {"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}.
// X-GitHub-Request-Id: set on EVERY response up front via res.setHeader, so
// it is present on JSON and git pkt-line replies alike. Its value is a
// deterministic per-process counter as hex — never random, never wall-clock
// (replay must be byte-identical).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BAD_CREDENTIALS = { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' };

/** A per-process response counter; the request id is its hex — deterministic. */
let requestCounter = 0;

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The single shared store, loaded once (dynamic import: store.ts may land later). */
type StoreLike = { viewer?: unknown; [key: string]: unknown };
let storePromise: Promise<StoreLike | null> | null = null;
function loadStore(): Promise<StoreLike | null> {
  if (storePromise === null) {
    storePromise = import('./store.ts')
      .then((mod) => {
        const Ctor = (mod as { Store?: new () => StoreLike }).Store;
        if (typeof Ctor !== 'function') return null;
        return new Ctor();
      })
      .catch((err) => {
        process.stderr.write(`[app] store module ./store.ts unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
        return null;
      });
  }
  return storePromise;
}

/** One surface module's handler, loaded once; null when the file is absent. */
type Handler = (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => Promise<boolean>;
const handlerCache = new Map<string, Promise<Handler | null>>();
function loadHandler(file: string, exportName: string): Promise<Handler | null> {
  let cached = handlerCache.get(file);
  if (cached === undefined) {
    cached = import(file)
      .then((mod) => {
        const fn = (mod as Record<string, unknown>)[exportName];
        return typeof fn === 'function' ? (fn as Handler) : null;
      })
      .catch((err) => {
        // Dev-time only: a surface module that has not landed yet. The wire
        // answer stays the GitHub 404 (never leak dev state); the log names it.
        process.stderr.write(`[app] surface module ${file} unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
        return null;
      });
    handlerCache.set(file, cached);
  }
  return cached;
}

export interface Ctx {
  store: StoreLike | null;
  token: string;
  requestId: string;
  path: string;
  query: URLSearchParams;
  method: string;
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  readBody(): Promise<Buffer>;
  authed(req: IncomingMessage): boolean;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Exact bearer match against the startup token (empty token authenticates nothing). */
function isAuthed(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  const header = req.headers.authorization;
  return header === `Bearer ${TOKEN}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // Start loading the store immediately so the first request rarely waits.
  void loadStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${(++requestCounter).toString(16)}`;
      // Set up front: present on every reply, JSON or git pkt-line, even on
      // handler-thrown errors (the catch below answers 500 JSON with it set).
      res.setHeader('x-github-request-id', requestId);
      let path = '/';
      let query = new URLSearchParams();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        path = url.pathname;
        query = url.searchParams;
      } catch {
        path = '/';
      }
      const method = req.method ?? 'GET';

      // Fast paths first: health probe and API root need no store and no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // Every other surface requires the exact bearer token.
      if (!isAuthed(req)) {
        sendJson(res, 401, BAD_CREDENTIALS);
        return;
      }

      // Per-request context (single body read, cached).
      let bodyCache: Promise<Buffer> | null = null;
      const readBody = (): Promise<Buffer> => {
        if (bodyCache === null) {
          bodyCache = new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', () => resolve(Buffer.concat(chunks)));
          });
        }
        return bodyCache;
      };
      const store = await loadStore();
      const ctx: Ctx = {
        store,
        token: TOKEN,
        requestId,
        path,
        query,
        method,
        json: (status: number, body: unknown, headers: Record<string, string> = {}) => sendJson(res, status, body, headers),
        readBody,
        authed: isAuthed,
      };

      try {
        // O(1)-ish prefix dispatch: exact matches, then one startsWith per
        // surface, then the .git infix check. No regex per request.
        let handler: Handler | null = null;
        if (path === '/api/graphql' || path === '/api/graphql/') {
          handler = await loadHandler('./graphql.ts', 'handleGraphql');
        } else if (path === '/mcp' || path === '/mcp/') {
          handler = await loadHandler('./mcp.ts', 'handleMcp');
        } else if (path.startsWith('/api/v3/')) {
          handler = await loadHandler('./rest.ts', 'handleRest');
        } else if (path.indexOf('.git/') > 1) {
          handler = await loadHandler('./git.ts', 'handleGit');
        }
        if (handler === null) {
          // No surface owns this route, or its module has not landed yet:
          // either way the wire answer is GitHub's 404 JSON (a missing
          // module never leaks a dev-time status onto the wire).
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const handled = await handler(req, res, ctx);
        if (!handled) sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down with it.
        if (!res.writableEnded) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch {
            try { res.end(); } catch { /* socket already gone */ }
          }
        }
        process.stderr.write(`[app] handler error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
