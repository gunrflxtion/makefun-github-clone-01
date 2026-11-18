// mcp.ts — Model Context Protocol endpoint: POST /mcp.
//
// JSON-RPC 2.0 over Streamable HTTP, speaking the 2026-07-28 revision the
// suite negotiates (kit program/env/src/mcp-client.ts) with the legacy
// handshake (2025-11-25 and earlier) as a fallback:
//
//   modern: server/discover (supportedVersions + capabilities + serverInfo),
//           every request declares its revision in _meta; no session.
//   legacy: initialize (echo the requested supported revision) +
//           notifications/initialized; no session is ever issued (the client
//           only carries a Mcp-Session-Id when the server hands one out).
//
// tools/list offers the six tools the suite needs (github-mcp-server names);
// tools/call executes them against the shared Store, so every effect is
// visible through REST immediately. Tool results are content blocks
// [{type: "text", text: JSON.stringify(...)}], with isError: true for tool
// failures. Unknown tools are JSON-RPC -32602; a body that is not JSON is
// HTTP 400 with JSON-RPC -32700 (the checks-mcp.ts parse-error check; the
// INTEGRATION.md {"message"} form applies to REST, not to this endpoint).
// No Authorization header is HTTP 401 — but auth is enforced by app.ts
// before dispatch, so this handler assumes the caller is authed.
//
// No Date.now / Math.random / crypto randomness anywhere. tools/list is a
// static array, so two calls answer byte-identical bodies. Pull-request
// create/merge reuse graphql.ts's helpers (same squash-merge bytes as
// rest.ts), so the MCP, GraphQL and REST views of one pull request agree.
//
// Wiring (INTEGRATION.md): app.ts routes POST /mcp here and calls
// `handleMcp(req, res, ctx)`; ctx carries the shared store, the token,
// requestId, path/query/method, `json(status, body)` and `readBody()`.
// Returns true when answered, false when the request is not this surface
// (non-POST, or no store yet — app.ts then 404s). `executeMcp(store,
// request)` is the pure JSON-RPC core (null for a notification) and is what
// tests drive directly.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPullInStore, mergePullInStore, type HandlerCtx } from './graphql.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Protocol constants.
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Tool definitions (static: tools/list is byte-identical across calls).
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'The state of the issues to list.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The branch the pull request merges from.' },
        base: { type: 'string', description: 'The branch the pull request merges into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// REST-shaped views (the same objects REST returns, so MCP and REST agree).
// ---------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: 0, type: 'User' },
    description: repo.description,
    private: repo.private,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user },
    labels: issue.labels,
    assignees: issue.assignees,
    locked: issue.locked,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { label: pull.head.label, ref: pull.head.ref, sha: pull.head.sha },
    base: { label: pull.base.label, ref: pull.base.ref, sha: pull.base.sha },
    user: { login: pull.user },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Tool execution. A ToolFailure is a tool-level error: the answer is a
// result with isError: true, not a JSON-RPC error.
// ---------------------------------------------------------------------------

class ToolFailure extends Error {}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolFailure(`${name} is required and must be a non-empty string`);
  return value;
}

function requireRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = requireString(args, 'owner');
  const name = requireString(args, 'repo');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`repository ${owner}/${name} does not exist`);
  return repo;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      if (store.getRepo(store.viewer.login, repoName) !== undefined) throw new ToolFailure(`repository ${store.viewer.login}/${repoName} already exists`);
      const repo = store.createRepo(store.viewer.login, repoName, { description, private: isPrivate });
      return textResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = requireRepo(store, args);
      return textResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = requireRepo(store, args);
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, { title, body });
      return textResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueView(repo, issue));
      return textResult(list);
    }
    case 'create_pull_request': {
      const repo = requireRepo(store, args);
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      const body = typeof args.body === 'string' ? args.body : '';
      const pull = createPullInStore(store, repo, { title, body, head, base });
      if (pull === undefined) throw new ToolFailure(`cannot create a pull request from ${head} into ${base}: one of the branches does not exist`);
      return textResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(store, args);
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(number)) throw new ToolFailure('pull_number is required and must be an integer');
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolFailure(`pull request #${number} does not exist`);
      const merged = mergePullInStore(store, repo, pull, 'MERGE');
      if (merged === undefined) throw new ToolFailure(`pull request #${number} cannot be merged (already merged, closed, or conflicting)`);
      return textResult(pullView(repo, merged));
    }
    default:
      throw new ToolFailure(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch (pure core; the HTTP layer only adds transport).
// ---------------------------------------------------------------------------

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/**
 * Execute one parsed JSON-RPC request object. Returns the response object,
 * or null for a notification (no id: nothing is answered). Unknown methods
 * are -32601; bad shapes are -32600.
 */
export function executeMcp(store: Store, request: unknown): JsonRpcResponse | null {
  if (!isRecord(request)) {
    return errorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }
  const id: JsonRpcId = 'id' in request && (typeof request.id === 'string' || typeof request.id === 'number') ? request.id : null;
  const isNotification = !('id' in request) || request.id === undefined || request.id === null;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    if (isNotification) return null;
    return errorResponse(id, JSON_RPC_INVALID_REQUEST, 'Invalid Request: method must be a non-empty string');
  }
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const info = serverInfo();
    const result = {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    };
    if (isNotification) return null;
    return resultResponse(id, result);
  }

  if (method === 'initialize') {
    if (isNotification) return null;
    const requested = params.protocolVersion;
    const negotiated = typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : null;
    if (negotiated === null) {
      return errorResponse(id, JSON_RPC_INVALID_PARAMS, `Unsupported protocol version: ${typeof requested === 'string' ? requested : 'none'}`, {
        supported: [...SUPPORTED_VERSIONS],
      });
    }
    return resultResponse(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }

  if (method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'ping') {
    if (isNotification) return null;
    return resultResponse(id, {});
  }

  if (method === 'tools/list') {
    if (isNotification) return null;
    return resultResponse(id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  }

  if (method === 'tools/call') {
    if (isNotification) return null;
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return errorResponse(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name');
    }
    if (!TOOLS.some((tool) => tool.name === name)) {
      return errorResponse(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      return resultResponse(id, callTool(store, name, args));
    } catch (err) {
      if (err instanceof ToolFailure) return resultResponse(id, errorResult(err.message));
      throw err;
    }
  }

  if (isNotification) return null;
  return errorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP handler (INTEGRATION.md contract).
// ---------------------------------------------------------------------------

/**
 * POST /mcp. Returns true when answered, false when the request is not this
 * surface (non-POST, or the store has not landed yet — app.ts then answers
 * its 404 JSON). Auth and the X-GitHub-Request-Id header are app.ts's job.
 * A notification (no id) is answered 202 with an empty body; a body that is
 * not JSON is HTTP 400 with JSON-RPC -32700. No Mcp-Session-Id is ever
 * issued, so the client keeps no session and never opens a GET SSE stream.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<boolean> {
  void req;
  const store = ctx.store;
  if (store === null) return false;
  if (ctx.method !== 'POST') return false;
  const raw = await ctx.readBody();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } });
    return true;
  }
  const response = executeMcp(store, parsed);
  if (response === null) {
    res.writeHead(202);
    res.end();
    return true;
  }
  ctx.json(200, response);
  return true;
}
