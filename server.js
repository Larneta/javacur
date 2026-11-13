#!/usr/bin/env node
/*
 * JavaCur local server — zero dependencies (Node 18+).
 *   node server.js            start on http://localhost:3000 (PORT env var to change)
 *   node server.js --no-seed  start with an empty database (first signup becomes Owner)
 *
 * Replaces the Claude-artifact database. Data lives in data/db.json as
 * a flat map of  "collection/docId"  ->  document.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const NO_SEED = process.argv.includes('--no-seed');

/* ----------------------------- storage ----------------------------- */
let store = {};
let version = 0; // bumped on every write so clients can cheaply detect change
let saveTimer = null;

function load() {
  try { store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return true; }
  catch (e) { store = {}; return false; }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}
process.on('SIGINT', () => { if (saveTimer) { clearTimeout(saveTimer); fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2)); } process.exit(0); });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const idForEmail = (email) => sha256(String(email).trim().toLowerCase()).slice(0, 24);

function seed() {
  const now = Date.now();
  const day = 86400000;
  const accounts = [
    ['Olivia', 'Owner',   'owner@javacur.local',  'owner',      { stars: 12 }],
    ['Sam',    'Super',   'super@javacur.local',  'superadmin', { stars: 8 }],
    ['Avery',  'Admin',   'admin@javacur.local',  'admin',      { stars: 6 }, { forum: true, ratings: true, deleteUsers: false, unlock: true }],
    ['Stu',    'Student', 'student@javacur.local','student',    { stars: 3 }],
    ['Lena',   'Learner', 'lena@javacur.local',   'student',    { stars: 1 }],
  ];
  accounts.forEach(([firstName, lastName, email, role, extra, permissions], i) => {
    const id = idForEmail(email);
    const createdAt = now - (i + 1) * day * 0.7;
    const profile = {
      firstName, lastName, dob: '1995-04-12', email, phone: '',
      passwordHash: sha256('Password1'), verified: true, createdAt, lastActive: now - i * 3600000,
      stars: extra.stars, completedLessons: [], quizBest: {}, practiced: [], challengeWins: 0, coursesCelebrated: [],
    };
    store['data/users/' + id + '/profile'] = profile;
    store['directory/' + id] = {
      firstName, lastName, email, stars: profile.stars, completedCount: 0, createdAt,
      lastActive: profile.lastActive, role, permissions: permissions || {}, failedAttempts: 0, lockedUntil: null,
    };
  });
  const owner = idForEmail('owner@javacur.local'), stu = idForEmail('student@javacur.local'), lena = idForEmail('lena@javacur.local');
  store['forum_posts/seed1'] = { authorId: stu, authorName: 'Stu S.', text: 'What is the difference between an interface and an abstract class?', createdAt: now - 3 * 3600000,
    replies: [{ authorId: owner, authorName: 'Olivia O.', text: 'Short version: an interface is a contract; an abstract class can also carry shared state and code.', createdAt: now - 2 * 3600000 }] };
  store['forum_posts/seed2'] = { authorId: lena, authorName: 'Lena L.', text: 'Anyone have a good analogy for dependency injection?', createdAt: now - 1 * 3600000, replies: [] };
  store['ratings/' + stu] = { stars: 5, comment: 'Love the first-grader explanations!', firstName: 'Stu', createdAt: now - 5 * 3600000, adminResponse: '' };
  store['ratings/' + lena] = { stars: 4, comment: 'Great lessons. More challenges please.', firstName: 'Lena', createdAt: now - 4 * 3600000, adminResponse: '' };
}

if (!load()) { if (!NO_SEED) seed(); save(); }

/* ----------------------------- db helpers ----------------------------- */
const segs = (p) => p.split('/').filter(Boolean);
function listCollection(name) {
  const prefix = name + '/';
  const out = [];
  for (const k of Object.keys(store)) {
    if (k.startsWith(prefix) && k.indexOf('/', prefix.length) === -1) out.push({ id: k.slice(prefix.length), data: store[k] });
  }
  return out;
}
function hasOwner() { return listCollection('directory').some((d) => d.data && d.data.role === 'owner'); }
function roleOf(id) { const d = store['directory/' + id]; return d ? (d.role || 'student') : 'student'; }

function writeDoc(p, op, data) {
  if (segs(p).length < 2 || segs(p).length % 2 !== 0) throw new Error('bad doc path');
  const existing = store[p];
  if (op === 'delete') { delete store[p]; }
  else if (op === 'update') {
    if (!existing) throw new Error('not-found');
    store[p] = { ...existing, ...data };
  } else { // set
    store[p] = data;
  }
  // The very first account created on an empty database becomes the Owner.
  if (op === 'set' && p.startsWith('directory/') && !existing && !hasOwnerExcept(p)) store[p].role = 'owner';
  version++; save();
}
function hasOwnerExcept(p) { return listCollection('directory').some((d) => 'directory/' + d.id !== p && d.data && d.data.role === 'owner'); }

/* ----------------------------- http ----------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }
function readBody(req) { return new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 5e6) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5);
      if (route === 'idForEmail' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, { id: idForEmail(b.email || '') }); }
      if (route === 'role' && req.method === 'GET') return send(res, 200, { role: roleOf(url.searchParams.get('id') || '') });
      if (route === 'doc') {
        const p = url.searchParams.get('path') || '';
        if (req.method === 'GET') { const d = store[p]; return send(res, 200, { exists: d !== undefined, data: d === undefined ? null : d }); }
        if (req.method === 'POST') { const b = await readBody(req); try { writeDoc(p, b.op, b.data); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message, code: e.message }); } }
      }
      if (route === 'collection' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.op === 'add') { const id = crypto.randomBytes(10).toString('hex'); writeDoc(b.name + '/' + id, 'set', b.data); return send(res, 200, { id }); }
        let docs = listCollection(b.name);
        if (b.orderBy) { const f = b.orderBy.field, dir = b.orderBy.dir === 'desc' ? -1 : 1; docs.sort((x, y) => ((x.data[f] > y.data[f]) - (x.data[f] < y.data[f])) * dir); }
        if (b.limit) docs = docs.slice(0, b.limit);
        return send(res, 200, { version, docs });
      }
      return send(res, 404, { error: 'unknown api route' });
    }
    // static files
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream'));
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});

server.listen(PORT, () => {
  console.log('\n  JavaCur is running →  http://localhost:' + PORT);
  console.log('  Data file: ' + DB_FILE);
  if (!NO_SEED && Object.keys(store).some((k) => k.startsWith('directory/'))) console.log('  Demo logins (password: Password1): owner@ / super@ / admin@ / student@ / lena@javacur.local');
  console.log('  Press Ctrl+C to stop.\n');
});
