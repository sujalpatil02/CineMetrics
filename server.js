// CineMetrics backend: zero-dependency Node.js (>=22.13) + built-in SQLite.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cinemetrics.db');
const ADMIN = process.env.ADMIN_TOKEN || '';
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS films(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT UNIQUE COLLATE NOCASE NOT NULL,
 year TEXT, genre TEXT, director TEXT, budget REAL NOT NULL CHECK(budget>0), gross REAL NOT NULL CHECK(gross>=0),
 imdb REAL, rt REAL, mc REAL, aud REAL, runtime REAL, oscars INTEGER, reviews TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'custom', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comparisons(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comparison_films(comparison_id INTEGER NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
 film_id INTEGER NOT NULL REFERENCES films(id) ON DELETE CASCADE, pos INTEGER NOT NULL, PRIMARY KEY(comparison_id,film_id));`);

db.exec(`CREATE TABLE IF NOT EXISTS catalog(title TEXT PRIMARY KEY COLLATE NOCASE, year TEXT, genre TEXT, director TEXT, budget REAL, gross REAL, imdb REAL, rt REAL, mc REAL, aud REAL, runtime REAL, oscars INTEGER)`);
{ const ins = db.prepare('INSERT OR REPLACE INTO catalog VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  fs.readFileSync(path.join(__dirname, 'catalog.csv'), 'utf8').split('\n').filter(Boolean).forEach(l => { const a = l.split('|'); ins.run(a[0], a[1], a[2], a[3], +a[4], +a[5], +a[6], +a[7], +a[8], +a[9], +a[10], +a[11]); }); }
const catFilm = r => ({ n: r.title, y: r.year, g: r.genre, d: r.director, b: r.budget, gr: r.gross, im: r.imdb, rt: r.rt, mc: r.mc, au: r.aud, rn: r.runtime, os: r.oscars });
async function tmdb(q) {          // optional live lookup: set TMDB_KEY to enable
  const k = process.env.TMDB_KEY; if (!k) return null;
  const j = async u => { const r = await fetch('https://api.themoviedb.org/3' + u + (u.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(k)); if (!r.ok) throw new HttpError(502, 'Movie service unavailable.'); return r.json(); };
  const hit = (await j('/search/movie?query=' + encodeURIComponent(q))).results?.[0]; if (!hit) return null;
  const d = await j('/movie/' + hit.id + '?append_to_response=credits,reviews');
  if (!(d.budget > 0) || !(d.revenue > 0)) throw new HttpError(422, '"' + d.title + '" has no budget/revenue data. Add it as a custom film.');
  const sc = Math.round((d.vote_average || 7) * 10), dir = (d.credits?.crew || []).find(c => c.job === 'Director');
  return { n: d.title, y: (d.release_date || '').slice(0, 4), g: d.genres?.[0]?.name || '', d: dir?.name || '', b: d.budget / 1e6, gr: d.revenue / 1e6, im: +(d.vote_average || 7).toFixed(1), rt: sc, mc: sc, au: sc, rn: d.runtime || 120, os: 0,
    rev: (d.reviews?.results || []).map(r => String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 400)).filter(Boolean).slice(0, 8) };
}
const pick = a => a[Math.floor(Math.random() * a.length)];
const gen = au => [0, 1, 2].map(() => pick(Math.random() * 100 < au ? seed.pb : seed.nb));
const toFilm = r => ({ id: r.id, n: r.title, y: r.year, g: r.genre, d: r.director, b: r.budget, gr: r.gross, im: r.imdb, rt: r.rt, mc: r.mc, au: r.aud, rn: r.runtime, os: r.oscars, rev: JSON.parse(r.reviews), src: r.source });
const insertFilm = db.prepare(`INSERT INTO films(title,year,genre,director,budget,gross,imdb,rt,mc,aud,runtime,oscars,reviews,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function addFilm(f, source) {
  const r = insertFilm.run(f.n, String(f.y ?? ''), f.g ?? '', f.d ?? '', f.b, f.gr, f.im, f.rt, f.mc, f.au, f.rn, f.os ?? 0, JSON.stringify(f.rev?.length ? f.rev : gen(f.au)), source);
  return toFilm(db.prepare('SELECT * FROM films WHERE id=?').get(r.lastInsertRowid));
}
if (!db.prepare('SELECT COUNT(*) c FROM films').get().c) seed.base.forEach(f => addFilm(f, 'seed'));

function saveComparison(ids, kind) {
  db.exec('BEGIN');
  try {
    const cid = db.prepare('INSERT INTO comparisons(kind) VALUES(?)').run(kind).lastInsertRowid;
    const ins = db.prepare('INSERT INTO comparison_films(comparison_id,film_id,pos) VALUES(?,?,?)');
    ids.forEach((id, i) => ins.run(cid, id, i));
    db.exec('COMMIT'); return getComparison(cid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function getComparison(id) {
  const c = db.prepare('SELECT * FROM comparisons WHERE id=?').get(id); if (!c) return null;
  const films = db.prepare('SELECT f.* FROM comparison_films cf JOIN films f ON f.id=cf.film_id WHERE cf.comparison_id=? ORDER BY cf.pos').all(id).map(toFilm);
  return { id: c.id, kind: c.kind, created_at: c.created_at, films };
}
const num = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
function validate(b) {
  const n = String(b.n ?? '').trim().slice(0, 60); if (!n) throw new HttpError(400, 'Title is required.');
  const bud = parseFloat(b.b), gr = parseFloat(b.gr);
  if (!(bud > 0) || !(gr >= 0)) throw new HttpError(400, 'Budget must be above 0 and gross a number.');
  const rev = Array.isArray(b.rev) ? b.rev.map(x => String(x).trim().slice(0, 500)).filter(Boolean).slice(0, 12) : [];
  return { n, y: String(b.y ?? '').slice(0, 4), g: String(b.g ?? '').slice(0, 30), d: String(b.d ?? '').slice(0, 60), b: bud, gr,
    im: num(b.im, 0, 10, 7), rt: num(b.rt, 0, 100, 70), mc: num(b.mc, 0, 100, 70), au: num(b.au, 0, 100, 70), rn: num(b.rn, 1, 600, 120), os: Math.round(num(b.os, 0, 100, 0)), rev };
}
const needAdmin = req => { if (ADMIN && req.headers['x-admin-token'] !== ADMIN) throw new HttpError(401, 'Admin token required.'); };

async function route(req, url, body) {
  const m = req.method, p = url.pathname;
  if (p === '/api/health') return { ok: true, films: db.prepare('SELECT COUNT(*) c FROM films').get().c, catalog: db.prepare('SELECT COUNT(*) c FROM catalog').get().c, live_lookup: !!process.env.TMDB_KEY };
  if (p === '/api/catalog/search' && m === 'GET') {        // typeahead over the whole catalog
    const q = (url.searchParams.get('q') || '').trim().replace(/[%_]/g, ''); if (q.length < 2) return { results: [] };
    return { results: db.prepare('SELECT title,year FROM catalog WHERE title LIKE ? ORDER BY (title LIKE ?) DESC, title LIMIT 10').all('%' + q + '%', q + '%').map(r => ({ n: r.title, y: r.year })) };
  }
  if (p === '/api/catalog/import' && m === 'POST') {       // bulk-load films into the searchable catalog
    needAdmin(req);
    const arr = Array.isArray(body.films) ? body.films.slice(0, 50000) : []; if (!arr.length) throw new HttpError(400, 'No films supplied.');
    const ins = db.prepare('INSERT OR REPLACE INTO catalog VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'); let n = 0;
    db.exec('BEGIN');
    try {
      for (const f of arr) { const t = String(f.n || '').trim().slice(0, 80), b = parseFloat(f.b), gr = parseFloat(f.gr); if (!t || !(b > 0) || !(gr >= 0)) continue;
        ins.run(t, String(f.y || '').slice(0, 4), String(f.g || '').slice(0, 30), String(f.d || '').slice(0, 60), b, gr, num(f.im, 0, 10, 7), num(f.rt, 0, 100, 70), num(f.mc, 0, 100, 70), num(f.au, 0, 100, 70), num(f.rn, 1, 600, 120), Math.round(num(f.os, 0, 100, 0))); n++; }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { imported: n, catalog: db.prepare('SELECT COUNT(*) c FROM catalog').get().c };
  }
  if (p === '/api/films' && m === 'GET') return { films: db.prepare('SELECT * FROM films ORDER BY id').all().map(toFilm) };
  if (p === '/api/films' && m === 'POST') {
    try { return [201, addFilm(validate(body), 'custom')]; }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That film is already in the database.'); throw e; }
  }
  if (p === '/api/films' && m === 'DELETE') { needAdmin(req); const r = db.prepare("DELETE FROM films WHERE source!='seed'").run(); return { deleted: Number(r.changes) }; }
  if (p === '/api/films/lookup' && m === 'POST') {         // find a film by name; store it from the catalog if needed
    const q = String(body.name || '').trim().toLowerCase(); if (!q) throw new HttpError(400, 'Please enter a movie name.');
    const ex = db.prepare('SELECT * FROM films WHERE title=? COLLATE NOCASE').get(q);
    if (ex) return { ...toFilm(ex), existing: true };
    const hits = db.prepare('SELECT * FROM catalog WHERE title LIKE ? ORDER BY title LIMIT 12').all('%' + q.replace(/[%_]/g, '') + '%').map(catFilm), exact = hits.find(f => f.n.toLowerCase() === q);
    let f = exact || (hits.length === 1 ? hits[0] : null), src = 'catalog';
    if (!f && hits.length > 1) throw new HttpError(409, 'Several matches: ' + hits.map(h => h.n).join(', ') + '. Be more specific.');
    if (!f) { f = await tmdb(q); src = 'tmdb'; if (f) { const again = db.prepare('SELECT * FROM films WHERE title=? COLLATE NOCASE').get(f.n); if (again) return { ...toFilm(again), existing: true }; } }
    if (!f) throw new HttpError(404, 'Not in the catalog.');
    return [201, addFilm(f, src)];
  }
  let mm;
  if ((mm = p.match(/^\/api\/films\/(\d+)$/)) && m === 'DELETE') {
    needAdmin(req); const f = db.prepare('SELECT source FROM films WHERE id=?').get(mm[1]);
    if (!f) throw new HttpError(404, 'Not found.'); if (f.source === 'seed') throw new HttpError(403, 'Seed films cannot be deleted.');
    db.prepare('DELETE FROM films WHERE id=?').run(mm[1]); return { deleted: 1 };
  }
  if (p === '/api/comparisons' && m === 'POST') {
    const ids = [...new Set((body.ids || []).map(Number))].filter(Number.isInteger);
    if (ids.length < 2 || ids.length > 3) throw new HttpError(400, 'Choose 2 or 3 films.');
    const ok = db.prepare(`SELECT COUNT(*) c FROM films WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).c;
    if (ok !== ids.length) throw new HttpError(400, 'Unknown film id.');
    return [201, saveComparison(ids, 'manual')];
  }
  if (p === '/api/comparisons' && m === 'GET') {
    const ids = db.prepare('SELECT id FROM comparisons ORDER BY id DESC LIMIT 15').all();
    return { comparisons: ids.map(r => getComparison(r.id)).map(c => ({ ...c, films: c.films.map(f => ({ id: f.id, n: f.n })) })) };
  }
  if ((mm = p.match(/^\/api\/comparisons\/(\d+)$/)) && m === 'GET') { const c = getComparison(mm[1]); if (!c) throw new HttpError(404, 'Not found.'); return c; }
  if (p.startsWith('/api/')) throw new HttpError(404, 'Unknown endpoint.');
  return null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (s, o, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h }); res.end(JSON.stringify(o)); };
  try {
    let body = {};
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > (url.pathname === '/api/catalog/import' ? 8e6 : 50000)) throw new HttpError(413, 'Payload too large.'); }
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
    }
    const out = await route(req, url, body);
    if (out !== null) return Array.isArray(out) ? send(out[0], out[1]) : send(200, out);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`CineMetrics running on http://localhost:${PORT}  (db: ${DB_PATH})`));
module.exports = server;
