// protocol.ts — shared wire discipline for the REST v3 surface (and the pieces
// app.ts reuses for every surface: auth, request ids, JSON replies, pagination).
//
// Owned by the REST+protocol worker. app.ts owns the server loop and builds the
// per-request Ctx; this module gives it the primitives so every surface answers
// the same way. Nothing here reads the wall clock or randomness: request ids are
// a per-process counter formatted as hex, timestamps come from Store.clock only.
//
// References (check file wins on any conflict):
//   program/env/src/wire.ts   API_PREFIX '/api/v3', AUTH_SCHEME 'Bearer',
//                              TOKEN_ENV 'MAKEFUN_SHOP_TOKEN'
//   program/env/src/checks-rest.ts  protocol group: JSON content type everywhere,
//                              JSON 404 for unknown routes, 400 for a malformed
//                              body, non-empty X-GitHub-Request-Id on every reply,
//                              {"message": string} error bodies.
//   program/env/src/rest-client.ts  Link header format the client parses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** The GitHub REST v3 prefix on the entry (wire.ts API_PREFIX). */
export const API_PREFIX = '/api/v3';

/** The env var naming the bearer token (wire.ts TOKEN_ENV). */
export const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

/** The authorization scheme every API call carries (wire.ts AUTH_SCHEME). */
export const AUTH_SCHEME = 'Bearer';

/** The Content-Type every JSON reply carries. */
export const JSON_TYPE = 'application/json; charset=utf-8';

/** The header carrying the deterministic per-process request id. */
export const REQUEST_ID_HEADER = 'x-github-request-id';

/** The header GET /api/v3/ answers with. */
export const OAUTH_SCOPES_HEADER = 'x-oauth-scopes';
export const OAUTH_SCOPES = 'repo, read:org';

/** The 401 body (STORE_API.md): GitHub-style, exact wording. */
export function unauthorizedBody(): { message: string; documentation_url: string } {
  return { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' };
}

/** The 404 body for unknown routes / missing resources: never HTML. */
export function notFoundBody(): { message: string } {
  return { message: 'Not Found' };
}

/** A 400 body for a malformed JSON request body. */
export function badRequestBody(message: string): { message: string } {
  return { message };
}

/** A 409 body (e.g. a stale contents sha). */
export function conflictBody(message: string): { message: string } {
  return { message };
}

/** A 422 body (e.g. an unknown label, a duplicate repository name). */
export function unprocessableBody(message: string): { message: string } {
  return { message };
}

/** A 405 body (e.g. merging a conflicted or already-merged pull request). */
export function methodNotAllowedBody(message: string): { message: string } {
  return { message };
}

// ---------------------------------------------------------------------------
// Token + request ids (read once at startup, never per request)

/** The bearer token, read once at startup from MAKEFUN_SHOP_TOKEN. Never hardcoded. */
export function readTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const token = env[TOKEN_ENV];
  return typeof token === 'string' ? token : '';
}

/**
 * A per-process request-id source. Values are `req-<counter as hex>`, counter
 * starting at 1, incrementing once per response. Deterministic, non-empty,
 * never random, never wall-clock.
 */
export function createRequestIdSource(): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `req-${counter.toString(16)}`;
  };
}

/** The Authorization header's bearer token, or null when absent / not Bearer. */
export function bearerTokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.startsWith(`${AUTH_SCHEME} `)) return null;
  const token = header.slice(AUTH_SCHEME.length + 1);
  return token === '' ? null : token;
}

/**
 * Whether the request carries exactly the expected token. A missing or wrong
 * token is false; an empty expected token matches nothing (the suite always
 * sets MAKEFUN_SHOP_TOKEN, and an unset token must not open the API).
 */
export function isAuthed(req: IncomingMessage, expectedToken: string): boolean {
  const presented = bearerTokenOf(req);
  if (presented === null || expectedToken === '') return false;
  if (presented.length !== expectedToken.length) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// JSON replies

/**
 * Answer with a JSON body + trailing newline, the JSON content type and the
 * request-id header. `requestId` is the value app.ts minted for this response
 * (handlers must not mint their own). Status 204 carries no body.
 * This is the helper app.ts / the Ctx.json implementation is built on.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (status === 204) {
    res.writeHead(204, { [REQUEST_ID_HEADER]: requestId, ...extraHeaders });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    [REQUEST_ID_HEADER]: requestId,
    ...extraHeaders,
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Request bodies

export type ParsedBody =
  | { ok: true; empty: true; value: undefined }
  | { ok: true; empty: false; value: unknown }
  | { ok: false; reason: string };

/**
 * Parse a request body buffer as JSON. An empty body is ok (treated as "no
 * body" by callers, usually `{}`). Anything present but unparsable is a 400.
 */
export function parseJsonBody(buf: Buffer): ParsedBody {
  return parseJsonText(buf.toString('utf8'));
}

/** Real JSON.parse wrapper kept separate so parseJsonBody stays obviously correct. */
export function parseJsonText(text: string): ParsedBody {
  if (text.length === 0) return { ok: true, empty: true, value: undefined };
  try {
    return { ok: true, empty: false, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'Invalid JSON' };
  }
}

/** Whether a parsed body is a plain JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Pagination (Link header + ?page=&per_page=, default 30)

export interface PageParams {
  page: number;
  perPage: number;
}

/** Parse ?page=&per_page=; defaults page 1, per_page 30; per_page clamped to 1..100. */
export function parsePagination(query: URLSearchParams): PageParams {
  const rawPage = Number.parseInt(query.get('page') ?? '', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  let perPage = Number.isFinite(rawPerPage) && rawPerPage >= 1 ? rawPerPage : 30;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

export interface Page<T> {
  items: T[];
  total: number;
  totalPages: number;
  page: number;
  perPage: number;
}

/** Slice one page out of a full list (no copy when the list already fits). */
export function paginate<T>(all: readonly T[], params: PageParams): Page<T> {
  const total = all.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / params.perPage);
  const start = (params.page - 1) * params.perPage;
  const items = start >= total ? [] : all.slice(start, start + params.perPage);
  return { items, total, totalPages, page: params.page, perPage: params.perPage };
}

/**
 * The GitHub `Link` header for a paginated list, or null when there is a single
 * page. URLs are absolute and same-origin (the client only follows same-origin
 * next links); every other query parameter is preserved.
 */
export function buildLinkHeader(
  origin: string,
  path: string,
  query: URLSearchParams,
  page: { page: number; totalPages: number },
): string | null {
  const totalPages = page.totalPages;
  if (totalPages <= 1) return null;
  const current = page.page;
  const urlFor = (target: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(target));
    const qs = next.toString();
    return `${origin}${path}${qs === '' ? '' : `?${qs}`}`;
  };
  const parts: string[] = [];
  if (current < totalPages) {
    parts.push(`<${urlFor(current + 1)}>; rel="next"`);
    parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (current > 1) {
    parts.push(`<${urlFor(1)}>; rel="first"`);
    parts.push(`<${urlFor(current - 1)}>; rel="prev"`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/** The request's origin (scheme + host) for absolute Link URLs. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------
// The per-request context app.ts builds (INTEGRATION.md). Handlers receive it;
// protocol.ts defines it so rest.ts / graphql.ts / mcp.ts share one shape.

import type { Store } from './store.ts';

export interface Ctx {
  /** The ONE store instance for the process (null only when store.ts has not landed; then surfaces answer 503). */
  store: Store | null;
  /** MAKEFUN_SHOP_TOKEN read once at startup. */
  token: string;
  /** Deterministic per-process request id for this response (`req-<hex>`). */
  requestId: string;
  /** URL pathname (no query), as app.ts parsed it. */
  path: string;
  /** Parsed query string. */
  query: URLSearchParams;
  /** HTTP method, upper-cased. */
  method: string;
  /** Answer with JSON (content-type + request-id + trailing newline); 204 has no body. */
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  /** Full request body; an empty Buffer when there is none. */
  readBody(): Promise<Buffer>;
  /** Whether the request carries exactly the startup token. */
  authed(req: IncomingMessage): boolean;
}
