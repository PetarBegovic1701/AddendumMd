#!/usr/bin/env node
'use strict';

/*
 * Addendum.md - lightweight, zero-dependency markdown reader/editor.
 *
 * Usage:
 *   node server.js [rootDir] [port]
 *
 *   rootDir   Directory whose .md files are served (recursively).
 *             Default: current working directory.
 *   port      TCP port. Default: 8888.
 *
 * Serves ONLY .md files under rootDir. No other file types are exposed
 * through the file API, and path traversal outside rootDir is rejected.
 * Review status and bookmarks live in state.json next to this script, filed
 * against each document's absolute path, so they sync across every device that
 * hits this server and stay with the document whatever root you open.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const PORT = parseInt(process.argv[3], 10) || 8888;

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, 'state.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PID_FILE = path.join(__dirname, 'server.pid');

// The active root can be changed at runtime from the UI and is remembered in
// config.json. It is either a local folder (kind 'fs') or the base URL of a
// static file server that exposes directory listings (kind 'http') - VS Code's
// Live Server, `python -m http.server`, nginx autoindex, and friends. An http
// root is READ-ONLY: those servers have no write verb.
// Precedence at startup: explicit CLI arg > saved config > cwd.

let ROOT = '';              // fs: absolute path.  http: base URL, always ends in '/'
let ROOT_KIND = 'fs';

function isUrl(s) { return typeof s === 'string' && /^https?:\/\//i.test(s.trim()); }

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ root: ROOT, kind: ROOT_KIND }, null, 2));
  } catch (e) { /* best effort */ }
}

function resolveInitialRoot() {
  if (process.argv[2]) {
    if (isUrl(process.argv[2])) return { root: normalizeBase(process.argv[2]), kind: 'http' };
    return { root: fs.realpathSync(path.resolve(process.argv[2])), kind: 'fs' };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // An http root is trusted back from config without re-probing: the remote
    // may simply be offline right now, and that must not stop Addendum.md booting.
    if (cfg.kind === 'http' && isUrl(cfg.root)) return { root: normalizeBase(cfg.root), kind: 'http' };
    if (cfg.root && fs.statSync(cfg.root).isDirectory()) return { root: fs.realpathSync(cfg.root), kind: 'fs' };
  } catch (e) { /* fall through */ }
  return { root: fs.realpathSync(process.cwd()), kind: 'fs' };
}

function setRoot(p) {
  const abs = fs.realpathSync(path.resolve(p));
  if (!fs.statSync(abs).isDirectory()) throw new Error('not a directory');
  ROOT = abs;
  ROOT_KIND = 'fs';
  treeCache = null;
  saveConfig();
  return ROOT;
}

// Probe first, commit second: a root that cannot be listed is never stored.
async function setHttpRoot(raw) {
  const base = normalizeBase(raw);
  await assertAllowedHost(new URL(base).hostname);
  if (!(await httpList(base, ''))) throw new Error(LISTING_HINT);
  ROOT = base;
  ROOT_KIND = 'http';
  treeCache = null;
  saveConfig();
  return ROOT;
}

function rootIsReadOnly() { return ROOT_KIND === 'http'; }

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', 'dist', 'build']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ---------- remote (http) roots ----------
//
// A static file server gives us far less than a filesystem does: a flat list of
// names per directory, with no types, no mtimes, and no write verb. Everything
// below is built from that one primitive.

const dns = require('dns');

const HTTP_TIMEOUT = 8000;
const TREE_TTL = 20000;          // a crawl is many requests; don't redo it per keystroke
const MAX_DEPTH = 8;
const MAX_REQUESTS = 400;        // hard ceiling on one crawl, so a deep tree cannot run away

// Public addresses are refused by default. Addendum.md listens on 0.0.0.0 with no
// auth, so without this anyone on the LAN could point it at an arbitrary host
// and read the response back out through /api/file - i.e. use this machine as
// an SSRF relay to places they cannot reach themselves.
const ALLOW_PUBLIC = process.env.ADDENDUM_MD_ALLOW_PUBLIC === '1';

const LISTING_HINT = 'that URL does not return a directory listing - if the folder ' +
  'contains an index.html the server sends that instead, and Addendum.md has nothing to read';

function normalizeBase(raw) {
  const u = new URL(String(raw).trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http:// or https:// URLs');
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

// 169.254/16 is deliberately absent: it carries the cloud metadata endpoint.
function ipIsPrivate(ip) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT range, where Tailscale lives
    return false;
  }
  const low = String(ip).toLowerCase();
  return low === '::1' || /^f[cd]/.test(low) || low.startsWith('fe80');
}

async function assertAllowedHost(hostname) {
  if (ALLOW_PUBLIC) return;
  const addr = await new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, a) => (err ? reject(new Error('cannot resolve ' + hostname)) : resolve(a)));
  });
  if (!ipIsPrivate(addr)) {
    throw new Error(hostname + ' (' + addr + ') is not on a private network. ' +
      'Set ADDENDUM_MD_ALLOW_PUBLIC=1 to allow public addresses.');
  }
}

function urlFor(base, rel) {
  const segs = String(rel).split('/').filter(Boolean).map(encodeURIComponent);
  return base + segs.join('/');
}

function parentUrl(base) {
  const u = new URL(base);
  if (u.pathname === '/') return '';                        // '' sends the picker back to local drives
  u.pathname = u.pathname.replace(/[^/]+\/$/, '');
  return u.toString();
}

async function mapPool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(width, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

function httpGet(url, accept) {
  return fetch(url, {
    headers: accept ? { Accept: accept } : {},
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
    redirect: 'follow',
  });
}

// serve-index and most autoindex implementations honour Accept: application/json
// and answer with a bare array of names. Returns null when the URL is not a
// browsable directory - a 404, or an index.html shadowing the listing.
async function httpList(base, relDir) {
  const url = relDir ? urlFor(base, relDir) + '/' : base;
  let r;
  try { r = await httpGet(url, 'application/json'); } catch (e) { return null; }
  if (!r.ok) return null;
  if (!/application\/json/i.test(r.headers.get('content-type') || '')) return null;
  let arr;
  try { arr = await r.json(); } catch (e) { return null; }
  return Array.isArray(arr) && arr.every((n) => typeof n === 'string') ? arr : null;
}

// Names we can classify without spending a request. Every miss costs one probe,
// and a probe that guesses wrong is a 404 - which is precisely what live-server's
// default logger prints on the other machine. Hence the deliberately broad list.
const FILE_EXT = new Set(('md txt json js mjs cjs ts tsx jsx css scss sass less html htm xml yml yaml toml ini cfg conf ' +
  'lock log csv tsv pdf zip gz tgz tar rar 7z png jpg jpeg gif svg webp avif ico bmp tiff mp3 wav ogg mp4 webm mov avi mkv ' +
  'woff woff2 ttf otf eot map sh bash cmd bat ps1 py rb go rs java class cs php sql db sqlite xlsx xls docx doc pptx ppt ' +
  'exe dll so dylib bin dat pyc min').split(' '));

// A dot-folder such as .kiro or .agent must NOT read as "extension kiro", or
// entire doc trees would be skipped - so a leading dot disqualifies the match.
function looksLikeFile(name) {
  const m = /[^.]\.([A-Za-z0-9]+)$/.exec(name);
  return !!m && FILE_EXT.has(m[1].toLowerCase());
}

// serve-index omits dot-entries from its listings entirely, though it will still
// serve them when addressed directly. A local root shows .kiro/.agent (see
// IGNORE_DIRS), so without this a remote root would silently hide the very trees
// this is usually pointed at. Depth 0 only, and only these names: each miss is a
// 404 in the other machine's editor, so the guessing stays cheap and bounded.
const DOT_DIRS = ['.kiro', '.agent', '.claude', '.docs', '.github', '.specs'];

// Same shape and ordering as buildTree(), so the sidebar cannot tell the
// difference. mtime is 0 throughout: a listing carries none, and finding out
// would cost one HEAD per file for something only the save path uses.
async function httpTree(base, relDir, depth, budget) {
  const names = await httpList(base, relDir);
  if (!names) return [];
  const files = [];
  const candidates = [];
  for (const name of names) {
    const rel = relDir ? relDir + '/' + name : name;
    if (name.toLowerCase().endsWith('.md')) {
      files.push({ type: 'file', name: name, path: rel, mtime: 0 });
    } else if (depth < MAX_DEPTH && !IGNORE_DIRS.has(name) && !looksLikeFile(name)) {
      candidates.push(name);
    }
  }
  if (depth === 0) {
    DOT_DIRS.forEach((d) => { if (candidates.indexOf(d) === -1) candidates.push(d); });
  }
  const probed = await mapPool(candidates, 6, async (name) => {
    if (budget.n >= MAX_REQUESTS) return null;
    budget.n++;
    const rel = relDir ? relDir + '/' + name : name;
    const children = await httpTree(base, rel, depth + 1, budget);
    return children.length ? { type: 'dir', name: name, children: children } : null;
  });
  const folders = probed.filter(Boolean);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return folders.concat(files);
}

let treeCache = null;            // { root, at, tree }

async function getTree(force) {
  if (ROOT_KIND === 'fs') return buildTree(ROOT);
  if (!force && treeCache && treeCache.root === ROOT && Date.now() - treeCache.at < TREE_TTL) {
    return treeCache.tree;
  }
  const tree = await httpTree(ROOT, '', 0, { n: 0 });
  treeCache = { root: ROOT, at: Date.now(), tree: tree };
  return tree;
}

// The http counterpart of safeMdPath: no filesystem to escape from, but the
// path still must not climb out of the base URL.
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel.length) return null;
  const clean = rel.replace(/\\/g, '/');
  if (!clean.toLowerCase().endsWith('.md')) return null;
  const segs = clean.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return clean;
}

async function httpRead(rel) {
  const r = await httpGet(urlFor(ROOT, rel));
  if (!r.ok) return null;
  const lm = r.headers.get('last-modified');
  return {
    buf: Buffer.from(await r.arrayBuffer()),
    mtime: lm ? (Date.parse(lm) || 0) : 0,
  };
}

function flattenTree(nodes, out) {
  nodes.forEach((nd) => {
    if (nd.type === 'file') out.push({ rel: nd.path, mtime: nd.mtime || 0 });
    else if (nd.children) flattenTree(nd.children, out);
  });
  return out;
}

// ---------- helpers ----------

function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });
}

// Resolve a client-supplied relative path to an absolute path that is
// provably inside ROOT and ends in .md. Returns null if invalid.
function safeMdPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  const decoded = decodeURIComponent(relPath).replace(/\\/g, '/');
  if (!decoded.toLowerCase().endsWith('.md')) return null;
  const abs = path.resolve(ROOT, '.' + path.sep + decoded);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

function relOf(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

// Recursively build a nested tree of folders + .md files.
function buildTree(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const folders = [];
  const files = [];
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;   // dot-folders like .agent/.kiro are allowed; only IGNORE_DIRS are skipped
      const children = buildTree(path.join(dir, ent.name));
      if (children.length) {
        folders.push({ type: 'dir', name: ent.name, children });
      }
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      const abs = path.join(dir, ent.name);
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch (e) { /* ignore */ }
      files.push({ type: 'file', name: ent.name, path: relOf(abs), mtime });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return folders.concat(files);
}

// ---------- downloads ----------
//
// Both download endpoints write straight to the response socket: nothing is
// staged in a temp file and no archive is ever held in memory as a whole.

// Flat, deterministic list of every .md under `dir` (same ordering and the same
// IGNORE_DIRS skips as buildTree, so a download matches the sidebar).
function collectMdFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  const dirs = [];
  const files = [];
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (!IGNORE_DIRS.has(ent.name)) dirs.push(ent.name);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      files.push(ent.name);
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  dirs.forEach((d) => collectMdFiles(path.join(dir, d), out));
  files.forEach((f) => {
    const abs = path.join(dir, f);
    let mtime = 0;
    try { mtime = fs.statSync(abs).mtimeMs; } catch (e) { /* ignore */ }
    out.push({ abs: abs, rel: relOf(abs), mtime: mtime });
  });
  return out;
}

function safeFileName(name) {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim();
  return clean || 'docs';
}

// RFC 6266: a plain ASCII filename plus a UTF-8 one for browsers that grok it.
function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

// res.write() with backpressure. Rejects if the client walks away mid-download
// so the walk stops instead of waiting on a 'drain' that will never fire.
function writeChunk(res, buf) {
  if (res.destroyed) return Promise.reject(new Error('client gone'));
  if (res.write(buf)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => { res.off('close', onClose); resolve(); };
    const onClose = () => { res.off('drain', onDrain); reject(new Error('client gone')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS packed date/time, as the zip format wants it.
function dosStamp(ms) {
  const d = new Date(ms || Date.now());
  const y = d.getFullYear();
  if (y < 1980) return { time: 0, date: 33 };          // 1980-01-01
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// A minimal, hand-rolled zip (deflate via Node's builtin zlib - still no npm
// dependencies). Each document is compressed and flushed as we go; only one
// file is in memory at a time. No zip64, so this tops out at 65535 files /
// 4 GB - orders of magnitude beyond any folder of markdown.
// `read` yields a Buffer per entry: straight off disk for a local root, or off
// the wire for a remote one. Nothing else here cares which.
async function streamZip(res, files, archiveName, prefix, read) {
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/zip',
    'Content-Disposition': attachment(archiveName),
  });
  const central = [];
  let offset = 0;
  for (const f of files) {
    let data;
    try { data = await read(f); } catch (e) { continue; }            // vanished mid-walk, or the remote broke
    if (!data) continue;
    const nameBuf = Buffer.from(prefix + f.rel, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const st = dosStamp(f.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    local.writeUInt16LE(8, 8);             // method: deflate
    local.writeUInt16LE(st.time, 10);
    local.writeUInt16LE(st.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // no extra field
    await writeChunk(res, Buffer.concat([local, nameBuf]));
    await writeChunk(res, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(st.time, 12);
    cd.writeUInt16LE(st.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 30);               // extra + comment lengths
    cd.writeUInt32LE(0, 34);               // disk number + internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + comp.length;
  }

  const dirBuf = Buffer.concat(central);
  await writeChunk(res, dirBuf);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(0, 4);                // this disk + start disk
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(dirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);               // no archive comment
  await writeChunk(res, eocd);
  res.end();
}

// Every document concatenated into one .md, with a table of contents.
async function streamBundle(res, files, fileName, title, read) {
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': MIME['.md'],
    'Content-Disposition': attachment(fileName),
  });
  let head = '# ' + title + ' - documentation bundle\n\n' +
    '_' + files.length + ' document' + (files.length === 1 ? '' : 's') +
    ', exported ' + new Date().toISOString().slice(0, 10) + '_\n\n## Contents\n\n';
  files.forEach((f) => { head += '- ' + f.rel + '\n'; });
  await writeChunk(res, Buffer.from(head, 'utf8'));
  for (const f of files) {
    let data;
    try { data = await read(f); } catch (e) { continue; }
    if (!data) continue;
    const text = data.toString('utf8');
    await writeChunk(res, Buffer.from('\n\n---\n\n## ' + f.rel + '\n\n' + text.replace(/\s+$/, '') + '\n', 'utf8'));
  }
  res.end();
}

// ---------- flags (reviewed / bookmarked / in progress) ----------
//
// Flags belong to the FILE, not to the root you happened to open. They are
// therefore stored against each document's absolute location - full path for a
// local file, full URL for a remote one - and translated to and from the
// root-relative paths the client speaks on every request. Open a repo, its
// parent, or one of its subfolders and the same document carries the same
// flags; two different repos that both contain docs/README.md stay separate.
//
// Keys always use forward slashes so the prefix arithmetic below is identical
// for local paths and URLs.

const FLAGS = ['reviewed', 'bookmarks', 'inProgress'];

function emptyState() {
  return { reviewed: {}, bookmarks: {}, inProgress: {} };
}

// Absolute key prefix of the active root, without a trailing slash.
function rootPrefix() {
  if (ROOT_KIND === 'http') return ROOT.replace(/\/+$/, '');
  return 'fs:' + ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Windows treats H:\Foo and h:\foo as one folder, so root membership is tested
// case-insensitively. The stored key keeps its original casing regardless: the
// relative path sliced back out of it has to match the tree the client drew.
function relFromKey(key, prefix) {
  const p = prefix + '/';
  const head = key.slice(0, p.length);
  const same = ROOT_KIND === 'http' ? head === p : head.toLowerCase() === p.toLowerCase();
  return same ? key.slice(p.length) : null;
}

function readStateFile() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return emptyState();                      // no file yet, or unreadable
  }
  const out = emptyState();
  if (!s || typeof s !== 'object') return out;
  FLAGS.forEach((f) => { if (s[f] && typeof s[f] === 'object') out[f] = s[f]; });
  return out;
}

function readState() {
  const all = readStateFile();
  const prefix = rootPrefix();
  const out = emptyState();
  FLAGS.forEach((flag) => {
    Object.keys(all[flag]).forEach((key) => {
      const rel = relFromKey(key, prefix);
      if (rel) out[flag][rel] = all[flag][key];
    });
  });
  return out;
}

// The client always PUTs the complete flag set for the tree it is looking at,
// so everything under the active root is replaced wholesale - that is what
// makes un-flagging work - while keys outside it are carried through untouched.
function writeState(state) {
  const all = readStateFile();
  const prefix = rootPrefix();
  const merged = emptyState();
  FLAGS.forEach((flag) => {
    Object.keys(all[flag]).forEach((key) => {
      if (!relFromKey(key, prefix)) merged[flag][key] = all[flag][key];
    });
    Object.keys(state[flag] || {}).forEach((rel) => {
      const clean = safeRel(rel);
      if (clean) merged[flag][prefix + '/' + clean] = state[flag][rel];
    });
  });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// One-shot upgrade of older state.json layouts to absolute keys. Runs at
// startup, before anything can read or write flags.
//
//   v1  flat { reviewed: { "docs/x.md": ... } }        - relative to the root
//                                                        that was last open
//   v2  { roots: { "fs:h:/repo": { reviewed: ... } } } - relative, per root
//
// v1 has no record of which root it described, so the active root at boot is
// the best available answer - it is the root the user last had open.
function migrateState() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return;                                   // no file yet, or unreadable
  }
  if (!s || typeof s !== 'object') return;

  const merged = emptyState();
  const absorb = (bucket, prefix) => {
    FLAGS.forEach((flag) => {
      const m = bucket[flag];
      if (!m || typeof m !== 'object') return;
      Object.keys(m).forEach((rel) => {
        const clean = safeRel(rel);
        if (clean) merged[flag][prefix + '/' + clean] = m[rel];
      });
    });
  };

  if (s.roots && typeof s.roots === 'object') {
    Object.keys(s.roots).forEach((key) => {
      // v2 stored native separators and lower-cased its local root keys;
      // recover the true casing where the bucket is the root we are booting
      // into, so sliced relative paths keep matching the tree. Other buckets
      // keep the only spelling on record.
      const norm = key.replace(/\\/g, '/').replace(/\/+$/, '');
      const prefix = norm.toLowerCase() === rootPrefix().toLowerCase() ? rootPrefix() : norm;
      absorb(s.roots[key], prefix);
    });
  } else if (FLAGS.some((f) => s[f])) {
    // Already absolute? Then some key sits under the root with a separator in
    // it that a relative path could never produce; leave a converted file be.
    if (FLAGS.some((f) => Object.keys(s[f] || {}).some((k) => /^(fs:|https?:)/i.test(k)))) return;
    absorb(s, rootPrefix());
  } else {
    return;
  }

  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { /* best effort; flags are not worth failing a boot over */ }
}

function readBody(req, limitBytes, cb) {
  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > limitBytes) {
      aborted = true;
      cb(new Error('payload too large'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!aborted) cb(null, Buffer.concat(chunks)); });
  req.on('error', (e) => { if (!aborted) cb(e); });
}

function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, name);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(abs).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

function winDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try { fs.accessSync(d); drives.push(String.fromCharCode(c) + ':'); } catch (e) { /* no drive */ }
  }
  return drives;
}

// List sub-folders of qpath for the folder picker (folder names only - never
// file contents). Empty qpath lists Windows drives / the filesystem root.
// Browse a remote server's folders. Same response shape as the local branch so
// the picker needs no special case, plus isUrl so it can label things.
async function listDirsHttp(res, raw) {
  let base;
  try {
    base = normalizeBase(raw);
    await assertAllowedHost(new URL(base).hostname);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  let names;
  try { names = await httpList(base, ''); } catch (e) { names = null; }
  if (!names) return sendJson(res, 400, { error: LISTING_HINT });

  const candidates = names.filter((n) => !IGNORE_DIRS.has(n) && !looksLikeFile(n));
  const confirmed = await mapPool(candidates, 6, async (n) => ((await httpList(base, n)) ? n : null));
  const dirs = confirmed.filter(Boolean).map((n) => ({ name: n, path: base + encodeURIComponent(n) + '/' }));
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  sendJson(res, 200, {
    path: base,
    parent: parentUrl(base),
    dirs: dirs,
    mdCount: names.filter((n) => /\.md$/i.test(n)).length,
    isUrl: true,
  });
}

function listDirs(res, qpath) {
  if (isUrl(qpath)) {
    listDirsHttp(res, qpath).catch((e) => sendJson(res, 400, { error: 'cannot reach that server: ' + e.message }));
    return;
  }
  if (!qpath) {
    if (process.platform === 'win32') {
      return sendJson(res, 200, {
        path: '', parent: null, isDrives: true,
        dirs: winDrives().map((d) => ({ name: d, path: d + '\\' })),
      });
    }
    qpath = '/';
  }
  let abs;
  try { abs = path.resolve(qpath); } catch (e) { return sendJson(res, 400, { error: 'bad path' }); }
  // Async on purpose: a UNC path pointing at an unreachable host can sit in the
  // SMB connect timeout for ~20s, and a sync read there would wedge the whole
  // server. This way only the one request waits.
  fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
    if (err) return sendJson(res, 400, { error: 'cannot open this folder' });
    const dirs = [];
    let mdCount = 0;
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;   // show dot-folders (.agent, .kiro, …); skip only IGNORE_DIRS
        dirs.push({ name: ent.name, path: path.join(abs, ent.name) });
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        mdCount++;
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    sendJson(res, 200, {
      path: abs,
      parent: parent === abs ? '' : parent,     // '' → go up to drives/root
      dirs: dirs,
      mdCount: mdCount,
    });
  });
}

function openBrowser(url) {
  if (process.env.MD_NO_OPEN) return;
  const cp = require('child_process');
  try {
    if (process.platform === 'win32') cp.spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { /* not fatal */ }
}

// Deferred until every helper above exists, since an http root normalizes on load.
(function initRoot() {
  const r = resolveInitialRoot();
  ROOT = r.root;
  ROOT_KIND = r.kind;
  migrateState();
})();

// ---------- request handling ----------

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  // API: file tree
  if (pathname === '/api/tree' && req.method === 'GET') {
    if (ROOT_KIND === 'fs') {
      return sendJson(res, 200, { root: ROOT, kind: 'fs', readOnly: false, tree: buildTree(ROOT) });
    }
    getTree(parsed.searchParams.get('refresh') === '1')
      .then((tree) => sendJson(res, 200, { root: ROOT, kind: 'http', readOnly: true, tree: tree }))
      .catch((e) => sendJson(res, 502, { error: 'cannot read that server: ' + e.message }));
    return;
  }

  // API: current root folder
  if (pathname === '/api/root' && req.method === 'GET') {
    return sendJson(res, 200, { root: ROOT, kind: ROOT_KIND, readOnly: rootIsReadOnly() });
  }

  // API: change the root folder
  if (pathname === '/api/root' && req.method === 'PUT') {
    readBody(req, 64 * 1024, (err, buf) => {
      if (err) return sendJson(res, 413, { error: 'payload too large' });
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      if (typeof payload.path !== 'string' || !payload.path.trim()) {
        return sendJson(res, 400, { error: 'path required' });
      }
      const want = payload.path.trim();
      if (isUrl(want)) {
        setHttpRoot(want)
          .then((root) => sendJson(res, 200, { ok: true, root: root, kind: 'http', readOnly: true }))
          .catch((e) => sendJson(res, 400, { error: 'not a usable server: ' + e.message }));
        return;
      }
      try {
        const root = setRoot(want);
        sendJson(res, 200, { ok: true, root: root, kind: 'fs', readOnly: false });
      } catch (e) {
        sendJson(res, 400, { error: 'not a usable folder: ' + e.message });
      }
    });
    return;
  }

  // API: list sub-folders (for the folder picker). No file contents exposed.
  if (pathname === '/api/dirs' && req.method === 'GET') {
    return listDirs(res, parsed.searchParams.get('path') || '');
  }

  // API: read a single markdown file
  if (pathname === '/api/file' && req.method === 'GET') {
    if (ROOT_KIND === 'http') {
      const rel = safeRel(parsed.searchParams.get('path'));
      if (!rel) return sendJson(res, 400, { error: 'invalid path' });
      httpRead(rel)
        .then((got) => {
          if (!got) return sendJson(res, 404, { error: 'not found' });
          sendJson(res, 200, { path: rel, content: got.buf.toString('utf8'), mtime: got.mtime, readOnly: true });
        })
        .catch((e) => sendJson(res, 502, { error: 'fetch failed: ' + e.message }));
      return;
    }
    const abs = safeMdPath(parsed.searchParams.get('path'));
    if (!abs) return sendJson(res, 400, { error: 'invalid path' });
    fs.readFile(abs, 'utf8', (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch (e) { /* ignore */ }
      sendJson(res, 200, { path: relOf(abs), content: data, mtime });
    });
    return;
  }

  // API: write a single markdown file
  if (pathname === '/api/file' && req.method === 'PUT') {
    if (ROOT_KIND === 'http') {
      return sendJson(res, 501, { error: 'this folder is served over HTTP and is read-only' });
    }
    const abs = safeMdPath(parsed.searchParams.get('path'));
    if (!abs) return sendJson(res, 400, { error: 'invalid path' });
    readBody(req, 20 * 1024 * 1024, (err, buf) => {
      if (err) return sendJson(res, 413, { error: 'payload too large' });
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      if (typeof payload.content !== 'string') {
        return sendJson(res, 400, { error: 'content required' });
      }
      // The root is server-wide state. A client that still has the previous one
      // open would otherwise write its buffer to the same relative path inside
      // the new root - a different file entirely.
      if (typeof payload.root === 'string' && payload.root !== ROOT) {
        return sendJson(res, 412, { error: 'the root folder changed since this document was opened' });
      }
      // Guard against clobbering a file changed on disk since it was loaded.
      if (typeof payload.baseMtime === 'number' && fs.existsSync(abs)) {
        const current = fs.statSync(abs).mtimeMs;
        if (Math.abs(current - payload.baseMtime) > 1 && !payload.force) {
          return sendJson(res, 409, { error: 'file changed on disk', mtime: current });
        }
      }
      try {
        fs.writeFileSync(abs, payload.content, 'utf8');
      } catch (e) {
        return sendJson(res, 500, { error: 'write failed: ' + e.message });
      }
      const mtime = fs.statSync(abs).mtimeMs;
      sendJson(res, 200, { ok: true, path: relOf(abs), mtime });
    });
    return;
  }

  // API: download one markdown file, piped straight off disk
  if (pathname === '/api/download' && req.method === 'GET') {
    if (ROOT_KIND === 'http') {
      const rel = safeRel(parsed.searchParams.get('path'));
      if (!rel) return sendJson(res, 400, { error: 'invalid path' });
      httpRead(rel)
        .then((got) => {
          if (!got) return sendJson(res, 404, { error: 'not found' });
          send(res, 200, got.buf, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': got.buf.length,
            'Content-Disposition': attachment(rel.split('/').pop()),
          });
        })
        .catch((e) => sendJson(res, 502, { error: 'fetch failed: ' + e.message }));
      return;
    }
    const abs = safeMdPath(parsed.searchParams.get('path'));
    if (!abs) return sendJson(res, 400, { error: 'invalid path' });
    let st;
    try { st = fs.statSync(abs); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': attachment(path.basename(abs)),
    });
    const rs = fs.createReadStream(abs);
    rs.on('error', () => res.destroy());
    return rs.pipe(res);
  }

  // API: download every markdown file under ROOT (?format=zip | md)
  if (pathname === '/api/download-all' && req.method === 'GET') {
    const format = parsed.searchParams.get('format') === 'md' ? 'md' : 'zip';
    const gather = ROOT_KIND === 'http'
      // Reuse the cached crawl rather than walking the remote a second time.
      ? getTree(false).then((tree) => ({
        files: flattenTree(tree, []),
        base: safeFileName(decodeURIComponent(new URL(ROOT).pathname.replace(/\/$/, '').split('/').pop() || new URL(ROOT).hostname)),
        read: (f) => httpRead(f.rel).then((got) => (got ? got.buf : null)),
      }))
      : Promise.resolve({
        files: collectMdFiles(ROOT, []),
        base: safeFileName(path.basename(ROOT)),
        read: (f) => fs.readFileSync(f.abs),
      });

    gather.then((g) => {
      if (!g.files.length) return sendJson(res, 404, { error: 'no markdown files here' });
      const done = format === 'md'
        ? streamBundle(res, g.files, g.base + '-docs.md', g.base, g.read)
        : streamZip(res, g.files, g.base + '-docs.zip', g.base + '-docs/', g.read);
      done.catch(() => { res.destroy(); });  // client hung up, or a read blew up mid-archive
    }).catch((e) => sendJson(res, 502, { error: 'cannot read that server: ' + e.message }));
    return;
  }

  // API: read state (reviewed + bookmarks)
  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, readState());
  }

  // API: write state
  if (pathname === '/api/state' && req.method === 'PUT') {
    readBody(req, 5 * 1024 * 1024, (err, buf) => {
      if (err) return sendJson(res, 413, { error: 'payload too large' });
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      // Flags are stored per root, and the client PUTs the whole set for the
      // tree it is looking at. One queued against the outgoing root would wipe
      // the incoming root's flags, so it is dropped instead.
      if (typeof payload.root === 'string' && payload.root !== ROOT) {
        return sendJson(res, 412, { error: 'the root folder changed' });
      }
      const state = {
        reviewed: payload.reviewed && typeof payload.reviewed === 'object' ? payload.reviewed : {},
        bookmarks: payload.bookmarks && typeof payload.bookmarks === 'object' ? payload.bookmarks : {},
        inProgress: payload.inProgress && typeof payload.inProgress === 'object' ? payload.inProgress : {},
      };
      try { writeState(state); } catch (e) {
        return sendJson(res, 500, { error: 'state write failed' });
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Static assets / app shell
  if (req.method === 'GET') {
    return serveStatic(res, pathname);
  }

  send(res, 405, 'Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  const local = 'http://localhost:' + PORT;
  console.log('');
  console.log('  Addendum.md is running.');
  console.log('  ------------------------------------------------');
  console.log('  Folder : ' + ROOT + (ROOT_KIND === 'http' ? '   (remote, read-only)' : ''));
  console.log('  On this PC : ' + local);
  lan.forEach((ip) => console.log('  On your phone : http://' + ip + ':' + PORT));
  console.log('  ------------------------------------------------');
  console.log('  A browser tab should open automatically.');
  console.log('  To stop: close this window, press Ctrl+C, or run "Addendum.md_stop.cmd".');
  console.log('');
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (e) { /* best effort */ }
  openBrowser(local);
});

function cleanupPid() { try { fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ } }
process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });
