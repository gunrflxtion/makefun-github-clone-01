# GRADING.md — grade-local log (integration worker)

T_ref (calibration.json, median of 3 house runs): push 1640.82 ms / clone
266.941 ms / read 2759.715 ms / write 348.965 ms (per-round totals).
Per-op targets (half T_ref): push <4.1 ms/op, clone <5.3→<3 ms/clone,
read <0.69 ms/req, write <0.87 ms/req.

## Run 0 — harness smoke only (2026-11-18 ~14:55 WIB, before any surface module landed)
- Harness: `/tmp/harness.mjs --mode direct` — 5/14 steps pass.
- Pass: healthz, api-root, no-token 401, unknown-repo 404, unknown-route 404+json.
- Fail (all blocked on missing modules, NOT on app.ts): create repo, get repo,
  malformed JSON 400, git push, git clone, create issue, get issue,
  graphql viewer login, mcp initialize+tools/list — `rest.ts`, `git.ts`,
  `graphql.ts`, `mcp.ts`, `store.ts` do not exist yet in the repo.
- grade-local not yet run (no surface to grade).

## Run 1 — grade-local --driver process (2026-11-18 ~15:00 WIB, FINISHED)
- Command (from kit dir):
  `node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun-github-clone/repo --driver process`
- Log: /tmp/grade-local-1.log. Kept trial:
  `/home/hatch/.makefun/trials/github-core-clone-01/01a1eda0-4075-71aa-98c0-77b8e418f6ab/trial-0`
- Result: **score 15/1000 — feature 15 (3/120 checks), agent 0/200, perf 0/200**,
  working 1, replay matched byte-for-byte, 0 model calls, spend $0.
- Checks passed (3): `protocol.unknown-route-json-404`, `repos.not-found`,
  `repos.root`. Per-group: git 0/30, repos 2/15, issues 0/15, pulls 0/20,
  graphql 0/20, mcp 0/15, protocol 1/5.
- Perf: all 4 workloads 0 pts, p50 sentinel 1e9 — every workload's setup
  failed at `POST /api/v3/user/repos → 404` (rest.ts missing at run time).
- Cause of every failure: surface modules not yet landed (rest.ts, git.ts,
  graphql.ts, mcp.ts absent). app.ts routing/auth/404 verified correct by
  the 3 passes (incl. `repos.not-found` — missing-repo 404 via the 404
  fallback; rest.ts must preserve that behaviour when it lands).
- Note: `repos.root` + `repos.not-found` passing pre-rest.ts is accidental
  (404 fallback); do NOT count them as REST coverage.

## Run 2 — pending
- Blocked on: rest.ts (+protocol.ts), git.ts, graphql.ts, mcp.ts landing.
- store.ts LANDED 2026-11-18 ~15:48 WIB (after run 1): `new Store()` no-arg,
  viewer = adaiversen/1000, clock base 2026-11-14T06:30:00.000Z — matches the
  INTEGRATION.md contract exactly; app.ts loads it with no error.
  STORE_API.md viewer default also fixed by the store worker.
- pack.ts also landed (store+git worker's file — not touched, not mine).

## Perf baseline (routing layer only, /tmp/perf-probe.mjs, this VM)
- Sequential keep-alive fetch: healthz 1.05 ms/req, api-root 0.80 ms/req,
  authed unknown-404 0.86 ms/req (2000 req each; includes undici client
  round-trip on a 1.5-CPU shared VM — NOT the trial sandbox).
- app.ts per-request work is O(1) string ops + 2 resolved-promise awaits
  (loadStore/loadHandler caches); the JSON build inside rest/git handlers
  will dominate the read/write workloads, not routing.

## Determinism audit (2026-11-18)
- `grep -rn "Date.now|new Date|Math.random|randomBytes"` over repo *.ts:
  ONE hit — pack.ts:258, a COMMENT ("Callers pass a fixed constant, never
  Date.now()"), not a call. app.ts + main.ts: zero hits.
- Harness `--replay`: two fresh servers, identical smoke sequence,
  transcript sha256 identical (`95f976620b50…` both runs) — PASS.
- Caveat: full determinism (git pack bytes, issue timestamps via Store.clock)
  can only be proven once rest/git land; re-run `--replay` + grade-local
  replay verdict then.

## Known integration facts (verified against kit sources)
- Viewer login is deterministically `adaiversen` (id 1000) from wire.ts
  SCENARIO_SEED — STORE_API.md's `forge`/1 default is wrong; see INTEGRATION.md.
- Every reply must carry non-empty `X-GitHub-Request-Id` (incl. 401/404/root).
- Auth is enforced before routing in app.ts (401 before 404 for unauthenticated
  unknown routes); all protocol checks call unknown routes authenticated, so
  this ordering is safe for the suite.
