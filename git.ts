// git.ts — git smart HTTP: GET info/refs, POST git-upload-pack (v2 + v0),
// POST git-receive-pack (v0). No `git` binary, no network, stdlib only.
//
// Wiring (app.ts, owned by the integration worker — see INTEGRATION.md):
// app.ts builds one Ctx per request and calls
//   handleGit(req, res, ctx)   // ctx = { store, token, requestId, path, query, method, json, readBody, authed }
// and falls through to its 404 JSON when handleGit returns false. Auth and
// X-GitHub-Request-Id are app.ts's job, not this handler's.
//
// Protocol notes (all verified against kit program/env/src/git-client.ts):
// - info/refs with `Git-Protocol: version=2` answers v2 (`version 2` +
//   capabilities); without it answers v0 (`<oid> <ref>` lines, capabilities
//   after NUL on the first line, `capabilities^{}` pseudo-ref when empty).
//   receive-pack is v0-only.
// - v2 capabilities: agent, ls-refs=unborn, fetch=shallow, object-format=sha1,
//   side-band-64k. v0 upload-pack caps add multi_ack(_detailed), thin-pack,
//   ofs-delta, shallow, symref=HEAD:<default branch>.
// - v0 receive-pack caps: report-status, report-status-v2, delete-refs,
//   side-band-64k, ofs-delta, agent, object-format=sha1.
// - fetch (v2 sections acknowledgments / shallow-info / packfile; v0 NAK/ACK
//   + shallow lines + sideband pack): objects sent = depth-limited closure
//   of the wants minus the objects the client already holds (haves, cut off
//   at its shallow boundaries). Shallow boundaries are the included commits
//   whose parents were cut off by `deepen`; previously-shallow commits whose
//   parent is now included are reported `unshallow`.
// - receive-pack: the pack is parsed and validated (trailer checksum, every
//   object hash recomputes, every new tip's closure is present in the pack or
//   already in the store) BEFORE any ref moves; objects are stored even when
//   a ref update is refused (as real receive-pack does). Refusals are per-ref
//   `ng <ref> non-fast-forward`, never a whole-push failure.
// - Packs we generate are plain (no deltas), objects sorted by oid so the
//   bytes are stable for a given request; advertisements, ls-refs answers and
//   packs are cached per repo.version (bumped by every store ref change).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLinesFrom,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
} from './pack.ts';
import type { GitObject, GitObjectType } from './pack.ts';
import type { Repo, Store } from './store.ts';

export const GIT_AGENT = 'forge/1.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';

/** A pkt-line payload may carry at most this many pack bytes (band byte + data). */
const SIDEBAND_CHUNK = 65515;

export interface GitHandlerOptions {
  /** When set, every git request must carry `Authorization: Bearer <token>`. */
  token?: string;
}

interface CacheEntry {
  version: number;
  v2Up: Buffer;
  v0Up: Buffer;
  v0Recv: Buffer;
  lsRefs: Map<string, Buffer>;
  packs: Map<string, Buffer>;
}

const cacheByRepo = new WeakMap<Repo, CacheEntry>();

function cacheFor(repo: Repo): CacheEntry {
  const existing = cacheByRepo.get(repo);
  if (existing && existing.version === repo.version) return existing;
  const entry: CacheEntry = {
    version: repo.version,
    v2Up: Buffer.alloc(0),
    v0Up: Buffer.alloc(0),
    v0Recv: Buffer.alloc(0),
    lsRefs: new Map(),
    packs: new Map(),
  };
  cacheByRepo.set(repo, entry);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// small HTTP helpers
// ---------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

function badRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ oid, name }));
}

/** Peel a tag (recursively) to its commit; undefined when missing / not a commit. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function buildV2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${GIT_AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine('side-band-64k\n'),
    pktLineFlush(),
  ]);
}

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${defaultBranchRef(repo)} agent=${GIT_AGENT} object-format=sha1 multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow`
      : `report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=${GIT_AGENT} object-format=sha1 symref=HEAD:${defaultBranchRef(repo)}`;
  const serviceLine = `# service=${service}\n`;
  const parts: Buffer[] = [encodePktLine(serviceLine), pktLineFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(defaultBranchRef(repo)) ?? ZERO_OID;
  const lines: string[] = [];
  // HEAD first (real git order), then refs in insertion order; peeled tags
  // get a `^{}` line right after their own line.
  lines.push(`${headOid} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    const object = repo.objects.get(ref.oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  }
  lines.forEach((line, index) => {
    parts.push(encodePktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version: 2 | 0): Buffer {
  const cache = cacheFor(repo);
  if (version === 2) {
    if (cache.v2Up.length === 0) cache.v2Up = buildV2Advertisement();
    return cache.v2Up;
  }
  if (service === 'git-upload-pack') {
    if (cache.v0Up.length === 0) cache.v0Up = buildV0Advertisement(repo, service);
    return cache.v0Up;
  }
  if (cache.v0Recv.length === 0) cache.v0Recv = buildV0Advertisement(repo, service);
  return cache.v0Recv;
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function lsRefsList(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): LsRef[] {
  const out: LsRef[] = [];
  const headRef = defaultBranchRef(repo);
  const headOid = repo.refs.get(headRef);
  const head: LsRef = headOid
    ? { oid: headOid, name: 'HEAD', symrefTarget: opts.symrefs ? headRef : undefined }
    : { oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: opts.symrefs ? headRef : undefined };
  out.push(head);
  for (const ref of sortedRefs(repo)) {
    const entry: LsRef = { oid: ref.oid, name: ref.name };
    if (opts.peel) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled) entry.peeled = peeled;
      }
    }
    out.push(entry);
  }
  if (opts.prefixes.length === 0) return out;
  return out.filter((ref) => opts.prefixes.some((prefix) => ref.name.startsWith(prefix)));
}

function lsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const cache = cacheFor(repo);
  const key = JSON.stringify(opts);
  const cached = cache.lsRefs.get(key);
  if (cached) return cached;
  const parts: Buffer[] = [];
  for (const ref of lsRefsList(repo, opts)) {
    if (ref.unborn) {
      parts.push(
        encodePktLine(`unborn ${ref.name}${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`),
      );
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktLineFlush());
  const body = Buffer.concat(parts);
  cache.lsRefs.set(key, body);
  return body;
}

// ---------------------------------------------------------------------------------------------
// fetch: object selection
// ---------------------------------------------------------------------------------------------

interface FetchSelection {
  /** Oids to send, in deterministic (sorted) order. */
  send: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Walk commit parents from `roots`, collecting commit oids by generation
 * (root = generation 0). Stops descending past `maxDepth` generations and
 * past any commit in `stopAt` (included, but its parents are not walked).
 * Tags are followed to their target commit. Returns the included commits and
 * the set of commits whose parents were cut off (the shallow boundary).
 */
function walkCommits(
  repo: Repo,
  roots: readonly string[],
  opts: { maxDepth: number; stopAt?: ReadonlySet<string> },
): { commits: Map<string, number>; boundary: Set<string> } {
  const commits = new Map<string, number>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  let head = 0;
  for (const root of roots) {
    const object = repo.objects.get(root);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = peelToCommit(repo, root);
      if (target) queue.push({ oid: target, depth: 0 });
      continue;
    }
    if (object.type === 'commit') queue.push({ oid: root, depth: 0 });
  }
  while (head < queue.length) {
    const { oid, depth } = queue[head]!;
    head += 1;    const known = commits.get(oid);
    if (known !== undefined && known <= depth) continue;
    commits.set(oid, depth);
    if (depth >= opts.maxDepth) {
      boundary.add(oid);
      continue;
    }
    if (opts.stopAt?.has(oid)) {
      boundary.add(oid);
      continue;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { commits, boundary };
}

/** Tree+blob closure of one tree oid (trees only ever reference trees/blobs). */
function treeClosure(repo: Repo, treeOid: string): Set<string> {
  return collectReachable([treeOid], (oid) => repo.objects.get(oid), { allowMissing: true });
}

/**
 * Object closure of a set of oids WITHOUT following commit parents: each
 * commit contributes itself + its tree closure, each tag contributes itself
 * + its target's closure. (Following parents here would defeat depth limits
 * and the haves exclusion, so parents are walked explicitly by walkCommits
 * instead and added to the set beforehand.)
 */
function objectClosure(repo: Repo, oids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      out.add(oid);
      for (const treeOid of treeClosure(repo, parseCommit(object.data).tree)) out.add(treeOid);
    } else if (object.type === 'tag') {
      out.add(oid);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject) {
        if (targetObject.type === 'commit') {
          out.add(target);
          for (const treeOid of treeClosure(repo, parseCommit(targetObject.data).tree)) out.add(treeOid);
        } else {
          for (const sub of objectClosure(repo, [target])) out.add(sub);
        }
      }
    } else {
      for (const sub of collectReachable([oid], (id) => repo.objects.get(id), { allowMissing: true })) out.add(sub);
    }
  }
  return out;
}

/**
 * The objects a fetch must send.
 *
 * wants: the wanted oids (commits or tags). haves: oids the client holds.
 * shallow: the client's current shallow boundary — a have's ancestors past
 * a boundary are NOT held. depth: `deepen N` (undefined = full history).
 *
 * Included = depth-limited walk from the wants. Held = the haves' closure,
 * with the parent walk stopping at shallow boundaries. Sent = included minus
 * held. Shallow-out = included boundary commits whose parents were neither
 * sent nor held. Unshallow-out = old boundaries now included and no longer
 * on the boundary.
 */
function selectFetchObjects(repo: Repo, args: FetchArgs): FetchSelection {
  const wants = args.wants;
  const haves = args.haves;
  const shallow = args.shallow;
  const depth = args.depth;
  const shallowSet = new Set(shallow);
  // Included commits.
  const commits = new Map<string, number>();
  const boundary = new Set<string>();
  if (depth !== undefined && args.deepenRelative && shallow.length > 0) {
    // deepen-relative (real `git fetch --deepen=N`): walk from the wants
    // down to the current shallow boundary, then N generations past each
    // boundary commit. The new boundary is N generations below the old one.
    const phase1 = walkCommits(repo, wants, { maxDepth: Number.POSITIVE_INFINITY, stopAt: shallowSet });
    for (const [oid, level] of phase1.commits) commits.set(oid, level);
    const anchors = [...phase1.boundary].filter((oid) => phase1.commits.has(oid));
    for (const anchor of anchors) {
      const stopAt = new Set([...commits.keys()].filter((oid) => oid !== anchor));
      const sub = walkCommits(repo, [anchor], { maxDepth: depth, stopAt });
      for (const [oid, level] of sub.commits) {
        if (!commits.has(oid)) commits.set(oid, level);
      }
      for (const oid of sub.boundary) if (!commits.has(oid) || sub.commits.get(oid) === depth) boundary.add(oid);
    }
    // Anchors whose walk found nothing new stay on the boundary only when
    // they still have unsent parents (checked below via cutParent).
    for (const oid of anchors) boundary.add(oid);
  } else {
    const maxDepth = depth === undefined ? Number.POSITIVE_INFINITY : Math.max(0, depth - 1);
    // Included commits, walking through haves (a want that is also a have is
    // still a path to its parents, e.g. deepen). The client's shallow
    // boundary stops the walk ONLY when no deepen was requested: a plain
    // fetch on a shallow clone keeps it shallow, but an absolute `deepen N`
    // (including --unshallow's deepen 2147483647) must walk past the old
    // boundary for N generations.
    const stopAt =
      depth === undefined ? new Set([...shallowSet].filter((oid) => !wants.includes(oid))) : new Set<string>();
    const walked = walkCommits(repo, wants, { maxDepth, stopAt });
    for (const [oid, level] of walked.commits) commits.set(oid, level);
    for (const oid of walked.boundary) boundary.add(oid);
  }
  const included = new Set<string>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object) included.add(want);
  }
  for (const oid of commits.keys()) included.add(oid);
  if (args.includeTag) {
    for (const [oid, object] of repo.objects) {
      if (object.type !== 'tag') continue;
      const target = peelToCommit(repo, oid);
      if (target && included.has(target)) included.add(oid);
    }
  }
  const includedClosure = objectClosure(repo, included);

  // Held: each have + its tree closure, plus ancestors until a shallow boundary.
  const held = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (!object) continue;
    held.add(have);
    const target = object.type === 'tag' ? peelToCommit(repo, have) : have;
    if (target) {
      const { commits: heldCommits } = walkCommits(repo, [target], {
        maxDepth: Number.POSITIVE_INFINITY,
        stopAt: shallowSet,
      });
      for (const oid of heldCommits.keys()) held.add(oid);
    }
  }
  const heldClosure = objectClosure(repo, held);

  const send = [...includedClosure].filter((oid) => !heldClosure.has(oid)).sort();
  const shallowOut: string[] = [];
  for (const oid of boundary) {
    if (!commits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const unsentParent = parents.some((parent) => !send.includes(parent) && !heldClosure.has(parent) && !includedClosure.has(parent));
    const cutParent = parents.some((parent) => !included.has(parent));
    if (depth !== undefined && (unsentParent || cutParent)) shallowOut.push(oid);
  }
  shallowOut.sort();
  const unshallow = shallow.filter((oid) => included.has(oid) && !shallowOut.includes(oid)).sort();
  return { send, shallow: shallowOut, unshallow };
}

function buildPack(repo: Repo, oids: readonly string[]): Buffer {
  const cache = cacheFor(repo);
  const key = oids.join(',');
  const cached = cache.packs.get(key);
  if (cached) return cached;
  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // oids are already sorted by the caller, so pack bytes are stable.
  const pack = writePack(objects);
  cache.packs.set(key, pack);
  return pack;
}

/** Sideband-encode a pack: band-1 packets, each <= 65520 bytes framed. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** `deepen-relative`: the deepen count is generations past the current shallow boundary, not from the wants. */
  deepenRelative: boolean;
  /** `include-tag`: also send tags pointing at included commits. */
  includeTag: boolean;
  done: boolean;
}

function parseV2FetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, deepenRelative: false, includeTag: false, done: false };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    } else if (text === 'deepen-relative') args.deepenRelative = true;
    else if (text === 'include-tag') args.includeTag = true;
    else if (text === 'done') args.done = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not:
    // accepted and ignored (we always send a complete thin-pack-free pack).
  }
  return args;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  // acknowledgments section — ONLY when the client sent haves. Real git's
  // v2 fetch reader expects 'packfile' (or 'shallow-info') straight away
  // when it sent no haves, and dies with "expected 'packfile', received
  // 'acknowledgments'" otherwise.
  // Sections are separated by a DELIM packet (0001); only the final section
  // ends with a flush (0000). A flush after 'ready' makes real git treat
  // the response as finished ("expected packfile to be sent after 'ready'").
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    }
    parts.push(encodePktLine('ready\n'));
    parts.push(pktLineDelim());
  }
  // shallow-info section
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  // packfile section (only when there is a pack: an empty section would make
  // the client throw "packfile section carried no packets").
  if (selection.send.length > 0) {
    const pack = buildPack(repo, selection.send);
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    }
  }
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (selection.send.length > 0) {
    parts.push(...sidebandPack(buildPack(repo, selection.send)));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** POST git-upload-pack: v2 when the Git-Protocol header says so, else v0. */
function handleUploadPack(repo: Repo, req: IncomingMessage, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let packets;
  try {
    packets = decodePktLinesFrom(body).packets;
  } catch {
    throw new Error('malformed pkt-line in upload-pack request');
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (isV2) {
    const commandLine = lines[0] ?? '';
    if (commandLine.startsWith('command=ls-refs')) {
      const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (!afterDelim || packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8').replace(/\n$/, '');
        if (text === 'peel') opts.peel = true;
        else if (text === 'symrefs') opts.symrefs = true;
        else if (text === 'unborn') opts.unborn = true;
        else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(repo, opts) };
    }
    if (commandLine.startsWith('command=fetch')) {
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (afterDelim && packet.kind === 'data') args.push(packet.payload.toString('utf8'));
      }
      const parsed = parseV2FetchArgs(args);
      if (parsed.wants.length === 0) {
        return { status: 200, contentType: UPLOAD_RESULT, body: pktLineFlush() };
      }
      return { status: 200, contentType: UPLOAD_RESULT, body: fetchResponseV2(repo, parsed) };
    }
    throw new Error(`unknown v2 upload-pack command ${JSON.stringify(commandLine)}`);
  }
  // v0: wants (first section, capabilities may follow the first want oid),
  // shallow / deepen lines, flush, then haves + done, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, deepenRelative: false, includeTag: false, done: false };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      args.wants.push(rest.split(' ')[0]);
    } else if (text.startsWith('have ')) {
      args.haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      args.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    } else if (text === 'done') {
      args.done = true;
    }
    void seenFlush;
  }
  if (args.wants.length === 0) {
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat([encodePktLine('NAK\n'), pktLineFlush()]) };
  }
  return { status: 200, contentType: UPLOAD_RESULT, body: fetchResponseV0(repo, args) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: ReturnType<typeof decodePktLinesFrom>['packets']): { commands: PushCommand[]; capabilities: string[] } {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1).split(' ').filter(Boolean);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
      throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  return { commands, capabilities };
}

function reportResponse(reportLines: string[], sideband: boolean): Buffer {
  const report = encodePktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  if (!sideband) return report;
  // report-status inside side-band-64k: the pkt-lined report travels in band 1.
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += SIDEBAND_CHUNK) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + SIDEBAND_CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleReceivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  let decoded;
  try {
    decoded = decodePktLinesFrom(body);
  } catch {
    throw new Error('malformed pkt-line in receive-pack request');
  }
  const { commands, capabilities } = parsePushCommands(decoded.packets);
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = body.subarray(decoded.nextOffset);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  // Validate the pack first: nothing is stored and no ref moves when the
  // pack is corrupt or a new tip's closure is incomplete.
  let packObjects = new Map<string, GitObject>();
  let unpackError: string | null = null;
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackError = 'unpack error: no packfile received';
    } else {
      try {
        const checksum = verifyPackChecksum(packBytes);
        if (!checksum.ok) throw new Error(`pack trailer ${checksum.actual} does not match its bytes ${checksum.expected}`);
        const parsed = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        packObjects = parsed.objects;
        // Every new tip's closure must be in the pack or already in the
        // store. Checking only the pack objects' DIRECT references is
        // enough (and O(pack), not O(history)): every object already in the
        // store had its own references validated when it was stored, so a
        // pack object whose tree/parents/entries/target all resolve makes
        // the whole new closure resolve.
        const lookup = (oid: string): GitObject | undefined => packObjects.get(oid) ?? repo.objects.get(oid);
        for (const [oid, object] of packObjects) {
          const need: string[] = [];
          if (object.type === 'commit') {
            const commit = parseCommit(object.data);
            need.push(commit.tree, ...commit.parents);
          } else if (object.type === 'tree') {
            for (const entry of parseTree(object.data)) {
              if (entry.mode !== '160000') need.push(entry.oid);
            }
          } else if (object.type === 'tag') {
            need.push(parseTag(object.data).object);
          }
          for (const target of need) {
            if (!lookup(target)) throw new Error(`pack object ${oid} references missing object ${target}`);
          }
        }
        for (const command of commands) {
          if (command.newOid === ZERO_OID) continue;
          if (!lookup(command.newOid)) throw new Error(`new tip ${command.newOid} is not in the pack or the store`);
        }
      } catch (err) {
        unpackError = `unpack error: ${(err as Error).message}`;
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(unpackError);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack error`);
    return { status: 200, contentType: RECEIVE_RESULT, body: reportResponse(reportLines, sideband) };
  }

  // Store the unpacked objects (even for refs that will be refused).
  for (const [oid, object] of packObjects) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }

  reportLines.push('unpack ok');
  for (const command of commands) {
    if (command.newOid === ZERO_OID) {
      const result = store.deleteRef(repo, command.ref, command.oldOid);
      reportLines.push(result.ok ? `ok ${command.ref}` : `ng ${command.ref} ${result.reason}`);
      continue;
    }
    const result = store.updateRef(repo, command.ref, command.newOid, command.oldOid);
    reportLines.push(result.ok ? `ok ${command.ref}` : `ng ${command.ref} ${result.reason}`);
  }
  return { status: 200, contentType: RECEIVE_RESULT, body: reportResponse(reportLines, sideband) };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/;

/** True when this pathname is under a `<owner>/<repo>.git` prefix. */
export function isGitPath(pathname: string): boolean {
  return GIT_PATH.test(pathname);
}

/**
 * Handle one request. Returns true when the path is a git route (the
 * response has been sent, including 404 for a missing repo); false when the
 * path is not a git route at all (app.ts then answers its 404 JSON).
 *
 * Signature (INTEGRATION.md): `handleGit(req, res, ctx)` where ctx is the
 * per-request context app.ts builds: `{ store, token, requestId, path,
 * query, method, json, readBody, authed }`. app.ts enforces the bearer
 * token BEFORE dispatching and sets `X-GitHub-Request-Id` up front, so this
 * handler does neither: it assumes the caller is authed and never touches
 * that header. A null `ctx.store` returns false (app.ts answers 404).
 *
 * A legacy `(req, res, store, { token })` call is also accepted (local test
 * harness): then the URL is parsed from the request, the body is read from
 * it, and the token is checked here.
 */
export interface GitCtx {
  store: Store | null;
  token: string;
  requestId: string;
  path: string;
  query: URLSearchParams;
  method: string;
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  readBody(): Promise<Buffer>;
  authed(req: IncomingMessage): boolean;
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  ctxOrStore: GitCtx | Store,
  opts: GitHandlerOptions = {},
): Promise<boolean> {
  let store: Store | null;
  let pathname: string;
  let search: URLSearchParams;
  let method: string;
  let readBodyFn: () => Promise<Buffer>;
  let jsonFn: (status: number, body: unknown) => void;
  let checkAuth: () => boolean;

  if (ctxOrStore !== null && typeof ctxOrStore === 'object' && 'store' in ctxOrStore) {
    // app.ts context mode.
    const ctx = ctxOrStore as GitCtx;
    if (ctx.store === null) return false;
    store = ctx.store;
    pathname = ctx.path;
    search = ctx.query;
    method = ctx.method;
    readBodyFn = ctx.readBody;
    jsonFn = (status: number, body: unknown) => ctx.json(status, body);
    checkAuth = () => true; // app.ts already enforced the token
  } else {
    // Legacy direct mode (local test harness).
    store = ctxOrStore as Store;
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      pathname = url.pathname;
      search = url.searchParams;
    } catch {
      return false;
    }
    method = req.method ?? 'GET';
    readBodyFn = () => readBody(req);
    jsonFn = (status: number, body: unknown) => sendJson(res, status, body);
    checkAuth = () => {
      if (opts.token === undefined || opts.token === '') return true;
      return (req.headers.authorization ?? '') === `Bearer ${opts.token}`;
    };
  }

  const match = GIT_PATH.exec(pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const rest = match[3] ?? '';

  try {
    if (!checkAuth()) {
      jsonFn(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      jsonFn(404, { message: 'Not Found' });
      return true;
    }

    if (method === 'GET' && rest === 'info/refs') {
      const service = search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        jsonFn(404, { message: 'Not Found' });
        return true;
      }
      const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = advertisement(repo, service, isV2 ? 2 : 0);
      sendBuffer(res, 200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body);
      return true;
    }

    if (method === 'POST' && rest === 'git-upload-pack') {
      const body = await readBodyFn();
      const result = handleUploadPack(repo, req, body);
      sendBuffer(res, result.status, result.contentType, result.body);
      return true;
    }

    if (method === 'POST' && rest === 'git-receive-pack') {
      const body = await readBodyFn();
      const result = handleReceivePack(store, repo, body);
      sendBuffer(res, result.status, result.contentType, result.body);
      return true;
    }

    jsonFn(404, { message: 'Not Found' });
    return true;
  } catch (err) {
    // A malformed request (or any bug in one exchange) must never take the
    // server down: answer 400 and keep serving the next request.
    if (!res.headersSent) badRequest(res, `bad request: ${(err as Error).message}`);
    else res.end();
    return true;
  }
}

export { parseCommit, parseTag };
