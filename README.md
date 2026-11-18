# makefun-github-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/gunrflxtion/makefun-github-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/gunrflxtion/makefun-github-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process (stdlib only): git smart HTTP (upload-pack protocol v2 + receive-pack v0, own packfile/delta implementation), REST v3, GraphQL v4, and MCP (JSON-RPC 2.0 Streamable HTTP), all over one deterministic in-memory store. No git binary, no external services, no UI.

## Run it

```sh
node main.ts
```

The entry binds an ephemeral port, registers with the trial environment via `$MAKEFUN_ENV_URL`, and serves until the trial ends.

## Layout

- `main.ts`: lifecycle (bind, register, wait for done, exit 0).
- `app.ts`: the HTTP server and route dispatch.
- `store.ts`: the deterministic in-memory store (repos, issues, pulls, objects).
- `pack.ts`: packfile codec (pkt-line, delta encode/decode, SHA-1 objects).
- `git.ts`: git smart HTTP (info/refs, upload-pack v2, receive-pack v0).
- `rest.ts`: GitHub REST v3 (repos, issues, pulls, contents, labels).
- `protocol.ts`: auth, pagination, request ids.
- `graphql.ts`: GitHub GraphQL v4.
- `mcp.ts`: Model Context Protocol over streamable HTTP.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g838q1e8&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
