# INTEGRATION.md — wiring contract (integration worker owns app.ts)

## Viewer identity — CHECK FILE WINS over STORE_API.md default
`STORE_API.md` says viewer login `"forge"`, id 1. That is WRONG for the suite.
`program/env/src/wire.ts` builds the scenario from the FIXED seed
`SCENARIO_SEED = 0x6a09e667f3bcc909n`; `generateUsers(scenarioRng('users'), …)` makes
`users[0]` = `{ id: 1000, login: "adaiversen", name: "ada iversen",
email: "adaiversen@example.invalid" }`. Verified by running `buildScenario()`:
viewer login is `adaiversen` in every trial (the seed never changes).
- `store.viewer` MUST be exactly that user (id 1000, login `adaiversen`).
- GraphQL `viewer { login }` and REST `GET /api/v3/user` must return it.
- Repos created via REST belong to owner `adaiversen`.
- TODO for store worker: fix STORE_API.md's default line to `adaiversen`/1000.

## Handler contract (what app.ts imports — follow it exactly)
Each surface module exports ONE async handler with this signature:

```ts
export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean>;
export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean>;
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean>;
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean>;
```

`ctx` (built once per request by app.ts):
```ts
interface Ctx {
  store: Store;                 // the ONE store instance for the process
  token: string;                // MAKEFUN_SHOP_TOKEN read once at startup
  requestId: string;            // deterministic per-process counter, hex, non-empty
  path: string;                 // URL pathname (no query)
  query: URLSearchParams;       // parsed query string
  method: string;
  json(status: number, body: unknown, headers?: Record<string,string>): void;
  readBody(): Promise<Buffer>;  // full request body; empty Buffer when none
  authed(req): boolean;         // Authorization: Bearer <token> exact match
}
```
- Return `true` when the module handled the request (response already ended),
  `false` when the path is not its surface (app.ts then falls through to 404 JSON).
- Handlers MUST NOT write their own `X-GitHub-Request-Id`: app.ts sets it up
  front via `res.setHeader` on every response, so it is present on JSON and
  git pkt-line replies alike (handlers must not override it, and must not
  call `res.writeHead` with a different value). `ctx.requestId` carries the
  same value if a handler needs to read it. Handlers MUST set
  `Content-Type: application/json; charset=utf-8` on JSON replies (use
  `ctx.json`).
- Handlers MUST NOT read `Date.now()` / `new Date()` / `Math.random()` /
  `crypto.randomBytes()` for anything reaching a response or stored state
  (determinism: replay must be byte-identical; timestamps come from
  `Store.clock` only).
- Malformed JSON bodies on REST/GraphQL/MCP routes → `400 {"message": <string>}`
  (protocol check `protocolMalformedBody` posts raw `{"name":` to
  POST /api/v3/user/repos).
- Auth: every surface except `/healthz` and `GET /api/v3/` requires the exact
  bearer token; missing/wrong → `401 {"message":"Bad credentials",
  "documentation_url":"https://docs.github.com/rest"}`. app.ts enforces this
  BEFORE dispatching to rest/graphql/mcp/git handlers, so handlers can assume
  the caller is authed. (Handlers must still treat a repo under another owner
  as 404, never 403.)

## Routing (app.ts, O(1)-ish prefix table)
- `GET /healthz` → 200 `{"ok":true}` (no auth; request-id header present).
- `GET /api/v3` or `/api/v3/` → 200 API root + `x-oauth-scopes: repo, read:org`
  (no auth — starter behaviour, preserved).
- Path ends with `.git/...` or matches `/{owner}/{repo}.git/*` → git.ts.
- Path starts with `/api/v3/` → rest.ts (+ protocol.ts auth — app.ts does auth).
- Path exactly `/api/graphql` → graphql.ts.
- Path exactly `/api/graphql/` → graphql.ts (trailing slash tolerated).
- Path exactly `/mcp` (or `/mcp/`) → mcp.ts.
- Everything else → 404 `{"message":"Not Found"}` JSON, with request-id header.
- `X-GitHub-Request-Id`: present and non-empty on EVERY response (healthz,
  API root, 401s, 404s, git pkt-line responses too). Value: deterministic
  per-process counter as hex (`req-<counter hex>` — counter starts at 1,
  increments per response; never random, never wall-clock).
- One `Store` instance per process, created once in `createApp()` (lazy import
  of `./store.ts`; if the module is absent its surfaces answer 404 JSON on the
  wire and log the missing import to stderr — healthz/root still work).

## Module ownership (do not edit others' files)
- `store.ts`, `git.ts`, `pack.ts` — store+git worker
- `rest.ts`, `protocol.ts` — REST+protocol worker
- `graphql.ts` — GraphQL worker
- `mcp.ts` — MCP worker
- `app.ts`, `main.ts` (comment only), `/tmp` harness — integration worker (me)
- A surface whose module has not landed yet answers 404 JSON on the wire
  (indistinguishable from an unknown route); the missing import is logged
  to stderr by app.ts only.

## Requests / open questions for other workers (via coordinator)
1. store worker: confirm `Store` export shape — app.ts expects
   `import { Store } from './store.ts'` with `new Store()` (no args) and
   `store.viewer` = adaiversen user above. If your constructor differs,
   tell me the exact construction call.
2. store worker: fix STORE_API.md viewer default (`forge`/1 → `adaiversen`/1000).
3. rest worker: `GET /api/v3/meta` → 200 `{"installed_version": <non-empty string>}`
   (protocol check). What value will you use? (app.ts does not answer it.)
4. git worker: confirm `handleGit` handles `GET /{owner}/{repo}.git/info/refs`
   (both services) AND `POST .../git-upload-pack` + `git-receive-pack`,
   including 404 for a missing repo on info/refs.
5. graphql worker: confirm `handleGraphql` handles batched bodies (two
   operation documents in one body → two results in order).
6. mcp worker: confirm `handleMcp` handles `initialize` with protocolVersion
   `2026-07-28` AND the older handshake (`2025-11-25` or earlier), and
   answers non-JSON bodies with HTTP 400 + JSON-RPC -32700.

## Perf notes (for all workers — the hot paths)
- Read workload: 2,000 sequential GET issue on ONE keep-alive connection;
  T_ref 2759.715 ms total → 1.38 ms/req; target <0.7 ms/req.
  Keep the issue-GET path allocation-light: single `JSON.stringify` of a
  prebuilt object, no per-request Map re-creation, no double stringify/parse.
- Write workload: 200 sequential POST issue; T_ref 348.965 ms → 1.74 ms/req;
  target <0.9 ms/req.
- Push: 200 sequential receive-pack; T_ref 1640.82 ms → 8.2 ms/op; target <4 ms/op.
- Clone: 50 concurrent depth-1 clones of a 200-commit repo; T_ref 266.941 ms
  → 5.3 ms/clone; target <3 ms/clone.
