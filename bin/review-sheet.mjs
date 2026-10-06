#!/usr/bin/env node
/**
 * review-sheet — a local page where the reviewer (hero) picks an option / writes a memo
 * per question, and the answers land in a JSON file the session reads.
 *
 *   review-sheet serve <dir> [--port N] [--lan]      serve <dir> + the sheet page, save answers
 *   review-sheet new   <dir> <name>                  copy the template to <dir>/<name>-data.js
 *   review-sheet read  <dir> <id> [--json]           print saved answers joined with the questions (markdown)
 *   review-sheet wait  <dir> <id> [--timeout SEC]    block until <dir>/answers/<id>.json is (re)saved
 *   review-sheet ls    <dir>                         list sheets in <dir> and whether each is answered
 *
 * <dir> may be omitted everywhere: it then defaults to the INBOX (~/.review-sheet/inbox, or $REVIEW_SHEET_INBOX),
 * one folder every session drops its sheets into, served once (port 5600) like a queue — pending sheets on top,
 * submitted ones marked and listed below. `review-sheet install-inbox` registers that server with launchd (macOS).
 *
 * Layout of <dir> (the sheet dir, usually `review/` inside the repo):
 *   <name>-data.js      one sheet: `window.SHEET = { id, title, sections:[{ code, questions:[…] }] }`
 *   answers/<id>.json   what the reviewer saved: { sheet, answers:{ "<code>-<k>": { pick, memo } }, savedAt }
 *   anything else       images etc. the sheet references by relative path
 *
 * No dependencies. Node 18+.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'web');
const TEMPLATE = path.resolve(HERE, '..', 'templates', 'example-data.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const INBOX = process.env.REVIEW_SHEET_INBOX || path.join(os.homedir(), '.review-sheet', 'inbox');
export const INBOX_PORT = Number(process.env.REVIEW_SHEET_PORT) || 5600;

function usage(code = 2) {
  console.error(`usage:
  review-sheet serve [dir] [--port N] [--lan]
  review-sheet new   [dir] <name>
  review-sheet read  [dir] <id> [--json]
  review-sheet wait  [dir] <id> [--timeout SEC]
  review-sheet ls    [dir]
  review-sheet install-inbox [--port N]      # launchd: serve the inbox on boot (macOS)
  review-sheet chat new  <ch> [--title T] [--owner <session>] [--hub]   # 상시 채널 (inbox/chat/<ch>.jsonl) — hero ↔ 세션 메신저. 첫 채널 = 자동 허브
  review-sheet chat hub  [<ch>]                                  # 메인 허브 채널 보기/지정 — 받은편지함 맨 위 고정, /hub 가 그 채널로
  review-sheet chat ls | read <ch> [--all] [--json] | say <ch> <text…|-> | wait <ch> [--timeout SEC]
  (메모: http://127.0.0.1:${INBOX_PORT}/memo.html — hero 가 자기한테 보내는 메시지, CLI 없음·세션은 읽지 않는다)
  [dir] omitted → inbox ${INBOX} (one folder for every session; served on :${INBOX_PORT})`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan' || a === '--json' || a === '--all' || a === '--hub') flags[a.slice(2)] = true;
    else if (a === '--port' || a === '--timeout') flags[a.slice(2)] = Number(argv[++i]);
    else if (a === '--title' || a === '--owner') flags[a.slice(2)] = String(argv[++i] || '');
    else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); usage(); }
    else rest.push(a);
  }
  return { flags, rest };
}

/** Load `<dir>/<name>-data.js` the way the browser does (it assigns window.SHEET). Trusted local file. */
export function loadSheet(dir, name) {
  const file = path.join(dir, name + '-data.js');
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox, { filename: file, timeout: 1000 });
  const sheet = sandbox.window.SHEET;
  if (!sheet || !sheet.id || !Array.isArray(sheet.sections)) throw new Error(`${file}: window.SHEET = { id, sections:[…] } 가 없다`);
  return sheet;
}

export function answersFile(dir, id) { return path.join(dir, 'answers', id + '.json'); }

export function readAnswers(dir, id) {
  try { return JSON.parse(fs.readFileSync(answersFile(dir, id), 'utf8')); } catch { return null; }
}

/** Normalise a question (object form or the older tuple [k, q, opts, rec, why]). */
export function normQ(q) {
  if (Array.isArray(q)) return { k: String(q[0]), q: q[1], opts: (q[2] || []).map(o => Array.isArray(o) ? o : [o]), rec: q[3] || '', why: q[4] || '' };
  return { ...q, k: String(q.k), opts: (q.opts || []).map(o => Array.isArray(o) ? o : [o]), rec: q.rec || '', why: q.why || '' };
}

/** Answers joined with the questions, as markdown the session pastes into the SoT. */
export function renderMarkdown(sheet, saved) {
  const A = (saved && saved.answers) || {};
  const out = [`## ${sheet.title || sheet.id} — 답변`, ''];
  out.push(saved && saved.savedAt ? `저장 ${saved.savedAt} · sheet \`${sheet.id}\`` : `(아직 저장된 답변 없음) · sheet \`${sheet.id}\``, '');
  let n = 0, picked = 0;
  for (const s of sheet.sections) {
    const title = [s.code, s.title].filter(Boolean).join(' · ');
    out.push(`### ${title}${s.issue ? ` (${String(s.issue).startsWith('http') ? s.issue : '#' + s.issue})` : ''}`, '');
    out.push('| # | 질문 | 선택 | 메모 |', '| --- | --- | --- | --- |');
    for (const raw of s.questions || []) {
      const q = normQ(raw); n++;
      const a = A[`${s.code}-${q.k}`] || {};
      if (a.pick) picked++;
      const pick = a.pick ? a.pick : (a.memo ? '(메모만)' : '—');
      out.push(`| ${q.k} | ${cell(q.q)} | ${cell(pick)} | ${cell(a.memo || '')} |`);
    }
    const m = A[`${s.code}-memo`];
    if (m && m.memo) out.push('', `> 전체 메모: ${m.memo.replace(/\n/g, ' ')}`);
    out.push('');
  }
  out.push(`${picked}/${n} 선택됨`);
  return out.join('\n');
}
/* Table cell: the small markup set the page tolerates (<b> <i> <code> <br>) becomes markdown, so a sheet written with
   "<b>문제</b>…<br>" reads cleanly in the SoT too; "|" is escaped and newlines become <br> (markdown tables are one line). */
const cell = s => String(s == null ? '' : s)
  .replace(/<\s*\/?\s*(b|strong)\s*>/gi, '**').replace(/<\s*\/?\s*(i|em)\s*>/gi, '_').replace(/<\s*\/?\s*code\s*>/gi, '`')
  .replace(/<br\s*\/?>/gi, '<br>').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

function listSheets(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('-data.js')).sort().map(f => {
    const name = f.slice(0, -'-data.js'.length);
    try {
      const sheet = loadSheet(dir, name);
      const saved = readAnswers(dir, sheet.id);
      const qs = sheet.sections.flatMap(s => (s.questions || []).map(q => `${s.code}-${normQ(q).k}`));
      const picked = qs.filter(k => saved && saved.answers && saved.answers[k] && (saved.answers[k].pick || saved.answers[k].memo)).length;
      let createdAt = sheet.createdAt || null;
      if (!createdAt) { try { createdAt = fs.statSync(path.join(dir, f)).mtime.toISOString(); } catch { /* ignore */ } }
      const savedAt = saved && saved.savedAt || null;
      return { name, id: sheet.id, title: sheet.title || sheet.id, from: sheet.from || '', createdAt,
               total: qs.length, picked, savedAt, submitted: !!savedAt };
    } catch (e) { return { name, error: String(e.message || e) }; }
  }).sort((a, b) => {
    // queue order: errors first (they need fixing), then pending (newest first), then submitted (latest first)
    const g = x => x.error ? 0 : x.submitted ? 2 : 1;
    if (g(a) !== g(b)) return g(a) - g(b);
    return String(g(a) === 2 ? b.savedAt : b.createdAt || '').localeCompare(String(g(a) === 2 ? a.savedAt : a.createdAt || ''));
  });
}

/* ── 상시 채널 (chat) ───────────────────────────────────────────────────────────
   inbox/chat/<ch>.json   meta  { name, title, owner, createdAt, seenAt (owner read up to), heroSeenAt }
   inbox/chat/<ch>.jsonl  one message per line { id, ts, from: 'hero'|<owner>, text, files?: [name] }
   inbox/chat/<ch>.files/ attached images (page: 📎·paste·drop → POST /__chat/file), served at /chat/<ch>.files/<name>
   The page always posts as 'hero'; the owning session answers with `chat say` and listens with `chat wait`. */
const chatDir = root => path.join(root, 'chat');
const chatMetaFile = (root, ch) => path.join(chatDir(root), ch + '.json');
const chatLogFile = (root, ch) => path.join(chatDir(root), ch + '.jsonl');
const chatFilesDir = (root, ch) => path.join(chatDir(root), ch + '.files');
export const chatFilePath = (root, ch, name) => path.join(chatFilesDir(root, ch), name);
const FILE_RE = /^[a-z0-9]{6,32}\.(png|jpe?g|gif|webp|heic)$/;
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' };
export function saveChatFile(root, ch, type, buf) {
  const ext = IMG_EXT[String(type).split(';')[0].trim().toLowerCase()]; if (!ext) throw new Error('이미지(png/jpeg/gif/webp/heic)만');
  fs.mkdirSync(chatFilesDir(root, ch), { recursive: true });
  const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
  fs.writeFileSync(chatFilePath(root, ch, name), buf); return name;
}
export function readChatMeta(root, ch) { try { return JSON.parse(fs.readFileSync(chatMetaFile(root, ch), 'utf8')); } catch { return null; } }
function writeChatMeta(root, meta) {
  const f = chatMetaFile(root, meta.name);
  fs.writeFileSync(f + '.tmp', JSON.stringify(meta, null, 2) + '\n'); fs.renameSync(f + '.tmp', f);
}
export function readChatLog(root, ch) {
  try { return fs.readFileSync(chatLogFile(root, ch), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
export function appendChat(root, ch, from, text, files) {
  const meta = readChatMeta(root, ch); if (!meta) throw new Error(`채널 ${ch} 없음`);
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), from, text: String(text) };
  if (files && files.length) msg.files = files;
  fs.appendFileSync(chatLogFile(root, ch), JSON.stringify(msg) + '\n');
  return msg;
}
export function newChat(root, name, title, owner, hub) {
  if (!ID_RE.test(name)) throw new Error('채널 이름은 [a-z0-9-]');
  fs.mkdirSync(chatDir(root), { recursive: true });
  if (fs.existsSync(chatMetaFile(root, name))) throw new Error(`채널 ${name} 이미 있음`);
  const meta = { name, title: title || name, owner: owner || name, createdAt: new Date().toISOString(), seenAt: null, heroSeenAt: null };
  writeChatMeta(root, meta); fs.writeFileSync(chatLogFile(root, name), '');
  if (hub) setHub(root, name);
  return readChatMeta(root, name);
}
/* the hub = the main session's channel: pinned on top of the inbox and the target of /hub (phone bookmark). One at a time. */
export function setHub(root, name) {
  if (!readChatMeta(root, name)) throw new Error(`채널 ${name} 없음`);
  for (const c of listChats(root)) { const m = readChatMeta(root, c.name); const want = c.name === name; if (!!m.hub !== want) { m.hub = want; writeChatMeta(root, m); } }
}
export const hubChat = root => listChats(root).find(c => c.hub) || null;
export function listChats(root) {
  let names = []; try { names = fs.readdirSync(chatDir(root)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { /* none */ }
  return names.map(n => {
    const meta = readChatMeta(root, n); if (!meta) return null;
    const log = readChatLog(root, n); const last = log[log.length - 1] || null;
    const unreadHero = log.filter(m => m.from !== 'hero' && (!meta.heroSeenAt || m.ts > meta.heroSeenAt)).length;   // for hero: session replies not yet seen
    const unreadOwner = log.filter(m => m.from === 'hero' && (!meta.seenAt || m.ts > meta.seenAt)).length;         // for the session: hero messages not yet read
    return { ...meta, hub: !!meta.hub, count: log.length, last, unreadHero, unreadOwner };
  }).filter(Boolean).sort((a, b) => b.hub - a.hub);
}
function markSeen(root, ch, who) {
  const meta = readChatMeta(root, ch); if (!meta) return null;
  meta[who === 'hero' ? 'heroSeenAt' : 'seenAt'] = new Date().toISOString(); writeChatMeta(root, meta); return meta;
}

/* ── 메모 (memo) — hero 가 자기한테 보내는 답장 없는 메시지, 세션은 읽지 않는다 (hero 2026-10-06) ──
   inbox/memo/<name>.jsonl   one line per message {id, ts, text}. Send = append, delete = drop that line. No save/draft/conflict:
   hero said "답장 없는 1대1 메시지처럼, 저장 개념 없이" — the page copies a bubble on tap, that is what it is for.
   The pre-10-06 one-page pad (<name>.md) is split on blank lines into messages on first read and kept as <name>.md.migrated.
   No owner, no unread counts, no `wait`, no CLI. Nothing here is a SoT. */
const memoDir = root => path.join(root, 'memo');
const memoLog = (root, name) => path.join(memoDir(root), name + '.jsonl');
export const MEMO_DEFAULT = 'hero';
const memoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function migrateMemoPad(root, name) {   // old autosave pad → one message per paragraph, so each one copies on its own
  const md = path.join(memoDir(root), name + '.md');
  if (fs.existsSync(memoLog(root, name)) || !fs.existsSync(md)) return;
  const text = fs.readFileSync(md, 'utf8'), t0 = fs.statSync(md).mtime.getTime();
  const parts = text.split(/\n[ \t]*\n/).map(x => x.trim()).filter(Boolean);
  fs.writeFileSync(memoLog(root, name), parts.map((t, i) => JSON.stringify({ id: memoId(), ts: new Date(t0 - (parts.length - 1 - i) * 1000).toISOString(), text: t }) + '\n').join(''));
  fs.renameSync(md, md + '.migrated');
}
export function readMemo(root, name) {
  migrateMemoPad(root, name);
  let messages = [];
  try { messages = fs.readFileSync(memoLog(root, name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none yet */ }
  return { name, messages };
}
export function sendMemo(root, name, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 필요');
  fs.mkdirSync(memoDir(root), { recursive: true }); migrateMemoPad(root, name);
  const msg = { id: memoId(), ts: new Date().toISOString(), text };
  fs.appendFileSync(memoLog(root, name), JSON.stringify(msg) + '\n');
  return msg;
}
export function deleteMemo(root, name, id) {
  const { messages } = readMemo(root, name); const keep = messages.filter(m => m.id !== id);
  if (keep.length === messages.length) return false;
  const f = memoLog(root, name);
  fs.writeFileSync(f + '.tmp', keep.map(m => JSON.stringify(m) + '\n').join('')); fs.renameSync(f + '.tmp', f);
  return true;
}
/** For the inbox: name, count, last time — never the text (sessions can hit /api/inbox; the words stay hero's). */
export function listMemos(root) {
  let names = []; try { names = [...new Set(fs.readdirSync(memoDir(root)).filter(f => /\.(jsonl|md)$/.test(f)).map(f => f.replace(/\.(jsonl|md)$/, '')))]; } catch { /* none */ }
  if (!names.includes(MEMO_DEFAULT)) names.unshift(MEMO_DEFAULT);   // always there for hero, even before the first message
  return names.sort((a, b) => a === MEMO_DEFAULT ? -1 : b === MEMO_DEFAULT ? 1 : a.localeCompare(b)).map(n => {
    const { messages } = readMemo(root, n); const last = messages[messages.length - 1];
    return { name: n, count: messages.length, lastAt: last ? last.ts : null };
  });
}

/* Worker board — who is working on what, supplied from outside (review-sheet knows nothing of tmux/claude).
 * $REVIEW_SHEET_WORKERS=<url> → the server proxies that URL; else inbox/workers.json; else an empty board.
 * A dead URL falls back to the file and says why in `error`. Format: SKILL.md §일꾼 보드. */
export const WORKER_STATES = ['working', 'waiting_input', 'reply_ready', 'delegating', 'gone'];
export function workersFile(root) { return path.join(root, 'workers.json'); }
function normWorkers(doc, source) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const ok = x => x && typeof x === 'object' && typeof x.id === 'string';
  return {
    generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : null,
    groups: Array.isArray(d.groups) ? d.groups.filter(ok) : [],
    workers: Array.isArray(d.workers) ? d.workers.filter(ok) : [],
    source,
  };
}
export async function readWorkers(root, url = process.env.REVIEW_SHEET_WORKERS) {
  const errs = [];
  if (url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return normWorkers(await r.json(), 'url');
    } catch (e) { errs.push('url: ' + (e.message || e)); }
  }
  let board = null;
  try { board = normWorkers(JSON.parse(fs.readFileSync(workersFile(root), 'utf8')), 'file'); }
  catch (e) { if (e.code !== 'ENOENT') errs.push('file: ' + (e.message || e)); }
  board = board || normWorkers(null, 'none');
  if (errs.length) board.error = errs.join('; ');
  return board;
}

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', '404 ' + path.basename(file));
    send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
  });
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function indexHtml(dir) {
  const init = JSON.stringify({ dir, sheets: listSheets(dir), chats: listChats(path.resolve(dir)), memos: listMemos(path.resolve(dir)) }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>review-sheet</title><link rel="stylesheet" href="/sheet.css"><link rel="stylesheet" href="/workers.css">
<body class="rs-page"><main><div class="eyebrow">REVIEW-SHEET · 받은편지함</div><h1>답변 시트</h1>
<p class="lede">${esc(dir)} · <span id="rs-upd"></span> <button type="button" class="rs-refresh" id="rs-refresh" title="목록 새로고침">↻ 새로고침</button></p>
<button type="button" class="wb-strip" id="wb-strip" aria-expanded="false" hidden><span>🏗</span><span id="wb-sum"></span><span class="cnt"><span class="err" id="wb-err"></span> <span class="chev">▾</span></span></button>
<div class="wb-panel wb-list" id="wb-panel" hidden><div class="wb-bar"><span class="sp">방별 · 방 안은 🔴 먼저 · 탭하면 카드</span><a href="/workers.html"><button type="button">⤢ 크게 보기</button></a></div><div id="wb-board"></div></div>
<div id="rs-list"></div></main>
<script src="/workers.js"></script>
<script>
const INIT = ${init};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when = iso => { if(!iso) return ''; const d = new Date(iso); return d.toLocaleString('ko-KR', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}); };
const row = s => s.error
  ? '<li class="bad"><b>' + esc(s.name) + '</b> — ' + esc(s.error) + '</li>'
  : '<li class="' + (s.submitted ? 'done' : 'wait') + '"><a href="/sheet.html?d=' + encodeURIComponent(s.name) + '">' +
    '<span class="rs-badge">' + (s.submitted ? '✓ 제출됨' : '답 기다림') + '</span><b>' + esc(s.title) + '</b>' +
    '<small>' + (s.from ? esc(s.from) + ' · ' : '') + s.picked + '/' + s.total + ' 답함' +
    (s.submitted ? ' · 제출 ' + when(s.savedAt) : (s.createdAt ? ' · 보냄 ' + when(s.createdAt) : '')) + '</small></a></li>';
const chatRow = c => '<li class="chat' + (c.hub ? ' hub' : '') + (c.unreadHero ? ' new' : '') + '"><a href="/chat.html?c=' + encodeURIComponent(c.name) + '">' +
  '<span class="rs-badge">' + (c.unreadHero ? '새 답장 ' + c.unreadHero : c.hub ? '★ 메인 허브' : '💬 채널') + '</span><b>' + esc(c.title) + '</b>' +
  '<small>' + esc(c.owner) + (c.last ? ' · ' + esc(c.last.from === 'hero' ? '나' : c.last.from) + ': ' + esc(c.last.text.slice(0, 60)) + (c.last.text.length > 60 ? '…' : '') + ' · ' + when(c.last.ts) : ' · 아직 대화 없음') + '</small></a></li>';
const memoRow = m => '<li class="memo"><a href="/memo.html?m=' + encodeURIComponent(m.name) + '">' +
  '<span class="rs-badge">📝 메모</span><b>' + esc(m.name === 'hero' ? '나와의 메시지' : m.name) + '</b>' +
  '<small>' + (m.count ? m.count + '건 · 마지막 ' + when(m.lastAt) + ' · 누르면 복사' : '아직 없음 — 나한테 보내는 메시지, 세션은 읽지 않는다') + '</small></a></li>';
const render = d => {
  const wait = d.sheets.filter(s => s.error || !s.submitted), done = d.sheets.filter(s => !s.error && s.submitted);
  const chats = d.chats || [], memos = d.memos || [];
  document.getElementById('rs-list').innerHTML =
    (memos.length ? '<ul class="rs-index rs-memos">' + memos.map(memoRow).join('') + '</ul>' : '') +
    (chats.length ? '<h2>상시 채널 <span class="rs-n rs-n-chat">' + chats.reduce((a, c) => a + c.unreadHero, 0) + '</span></h2><ul class="rs-index">' + chats.map(chatRow).join('') + '</ul>' : '') +
    '<h2>답 기다리는 중 <span class="rs-n">' + wait.length + '</span></h2><ul class="rs-index">' +
    (wait.map(row).join('') || '<li class="empty">기다리는 시트 없음</li>') + '</ul>' +
    '<h2 class="rs-done-h">제출됨 <span class="rs-n">' + done.length + '</span></h2><ul class="rs-index">' +
    (done.map(row).join('') || '<li class="empty">아직 없음</li>') + '</ul>';
  document.getElementById('rs-upd').textContent = '갱신 ' + new Date().toLocaleTimeString('ko-KR');
  const n = wait.length + chats.reduce((a, c) => a + c.unreadHero, 0);
  document.title = (n ? '(' + n + ') ' : '') + 'review-sheet';
};
render(INIT);
// 일꾼 보드 — 공급자(REVIEW_SHEET_WORKERS / inbox/workers.json)가 없으면 띠 자체를 숨긴다. 펼침 여부는 이 브라우저에 기억.
const WB = window.WorkerBoard, wbStrip = document.getElementById('wb-strip'), wbPanel = document.getElementById('wb-panel');
const wbKey = 'rs-workers-open', wbOpen = () => { try { return localStorage.getItem(wbKey) === '1'; } catch(_){ return false; } };
const wbShow = open => { wbPanel.hidden = !open; wbStrip.setAttribute('aria-expanded', open); try { localStorage.setItem(wbKey, open ? '1' : '0'); } catch(_){} };
wbStrip.addEventListener('click', () => wbShow(wbPanel.hidden));
const workers = async () => {
  try {
    const b = await WB.fetchBoard();
    if (b.source === 'none' && !b.workers.length) { wbStrip.hidden = wbPanel.hidden = true; return; }
    if (wbStrip.hidden) { wbStrip.hidden = false; wbShow(wbOpen()); }
    document.getElementById('wb-sum').textContent = WB.summary(b);
    document.getElementById('wb-err').textContent = b.error ? '공급 오류' : '';
    wbStrip.title = b.error || '';
    WB.render(document.getElementById('wb-board'), b);
  } catch(_){}
};
WB.loadSprites('/sprites/').then(workers);
const refresh = async () => { workers(); const b = document.getElementById('rs-refresh'); b.disabled = true; try { const r = await fetch('/api/inbox', {cache:'no-store'}); if(r.ok) render(await r.json()); } catch(_){ document.getElementById('rs-upd').textContent = '갱신 실패 — 서버 확인'; } b.disabled = false; };
document.getElementById('rs-refresh').addEventListener('click', refresh);
setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if(!document.hidden) refresh(); });  // 폰: 탭 돌아오면 바로
</script></html>`;
}

export function startServer(dir, port = 0, host = '127.0.0.1') {
  const root = path.resolve(dir);
  fs.mkdirSync(path.join(root, 'answers'), { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__answers') {
      const qid = url.searchParams.get('sheet') || '';
      if (req.method === 'GET') {
        if (!ID_RE.test(qid)) return send(res, 400, 'text/plain', 'sheet=<id> required ([a-z0-9-])');
        return fs.readFile(answersFile(root, qid), (err, buf) => send(res, 200, 'application/json; charset=utf-8', err ? '{}' : buf));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
        req.on('end', () => {
          try {
            const json = JSON.parse(body);
            const id = qid || (typeof json.sheet === 'string' ? json.sheet : '');
            if (!ID_RE.test(id)) throw new Error('bad sheet id');
            json.sheet = id;
            json.savedAt = new Date().toISOString();
            const file = answersFile(root, id);
            fs.writeFileSync(file + '.tmp', JSON.stringify(json, null, 2) + '\n');
            fs.renameSync(file + '.tmp', file);
            send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, savedAt: json.savedAt, file }));
          } catch (e) { send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + (e.message || e)); }
        });
        return;
      }
      return send(res, 405, 'text/plain', 'method');
    }
    const cors = { 'access-control-allow-origin': '*' };
    if (url.pathname === '/api/sheets') return send(res, 200, TYPES['.json'], JSON.stringify({ dir: root, sheets: listSheets(root) }), cors);
    if (url.pathname === '/api/inbox') return send(res, 200, TYPES['.json'], JSON.stringify({ dir: root, sheets: listSheets(root), chats: listChats(root), memos: listMemos(root) }), cors);
    if (url.pathname === '/api/memo') {   // no CORS: hero's own, other dashboards don't get to read it
      const name = url.searchParams.get('m') || MEMO_DEFAULT;
      if (!ID_RE.test(name)) return send(res, 400, 'text/plain', 'm=<name> ([a-z0-9-])');
      return send(res, 200, TYPES['.json'], JSON.stringify(readMemo(root, name)));
    }
    if (url.pathname === '/__memo' && req.method === 'POST') {   // {text} → send one; {del: id} → remove one
      const name = url.searchParams.get('m') || MEMO_DEFAULT;
      if (!ID_RE.test(name)) return send(res, 400, 'text/plain', 'm=<name> ([a-z0-9-])');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          if (typeof j.del === 'string') { const ok = deleteMemo(root, name, j.del); return send(res, ok ? 200 : 404, TYPES['.json'], JSON.stringify({ ok, del: j.del })); }
          send(res, 200, TYPES['.json'], JSON.stringify(sendMemo(root, name, j.text)));
        } catch (e) { send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + (e.message || e)); }
      });
      return;
    }
    if (url.pathname === '/api/workers') {   // no CORS: the board carries what sessions were told and said
      readWorkers(root).then(b => send(res, 200, TYPES['.json'], JSON.stringify(b)), e => send(res, 500, 'text/plain; charset=utf-8', String(e.message || e)));
      return;
    }
    if (url.pathname === '/hub') { const h = hubChat(root); return h ? send(res, 302, 'text/plain', '', { location: '/chat.html?c=' + encodeURIComponent(h.name) }) : send(res, 302, 'text/plain', '', { location: '/' }); }
    if (url.pathname === '/api/chats') return send(res, 200, TYPES['.json'], JSON.stringify({ chats: listChats(root) }), cors);
    if (url.pathname === '/api/chat') {
      const ch = url.searchParams.get('c') || '';
      if (!ID_RE.test(ch)) return send(res, 400, 'text/plain', 'c=<channel> required');
      const meta = readChatMeta(root, ch); if (!meta) return send(res, 404, 'text/plain', 'no such channel');
      return send(res, 200, TYPES['.json'], JSON.stringify({ meta, messages: readChatLog(root, ch) }), cors);
    }
    if (url.pathname === '/__chat/file' && req.method === 'POST') {   // raw image body → inbox/chat/<ch>.files/<name>
      const ch = url.searchParams.get('c') || '';
      if (!ID_RE.test(ch) || !readChatMeta(root, ch)) return send(res, 404, 'text/plain', 'no such channel');
      const chunks = []; let n = 0, big = false;
      req.on('data', c => { n += c.length; if (n > 20e6) { big = true; req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (big) return;
        try { send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, name: saveChatFile(root, ch, req.headers['content-type'], Buffer.concat(chunks)) })); }
        catch (e) { send(res, 400, 'text/plain; charset=utf-8', String(e.message || e)); }
      });
      return;
    }
    if (url.pathname === '/__chat' && req.method === 'POST') {
      const ch = url.searchParams.get('c') || '';
      if (!ID_RE.test(ch) || !readChatMeta(root, ch)) return send(res, 404, 'text/plain', 'no such channel');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e5) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          let msg = null;
          const files = (Array.isArray(j.files) ? j.files : []).filter(f => typeof f === 'string' && FILE_RE.test(f) && fs.existsSync(chatFilePath(root, ch, f)));
          const text = typeof j.text === 'string' ? j.text.trim() : '';
          if (text || files.length) msg = appendChat(root, ch, 'hero', text, files);   // the page is always hero
          const meta = markSeen(root, ch, 'hero');
          send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, msg, meta }));
        } catch (e) { send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + (e.message || e)); }
      });
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '/index.html') return send(res, 200, TYPES['.html'], indexHtml(root));
    if (['/sheet.html', '/sheet.css', '/chat.html', '/memo.html', '/workers.html', '/workers.css', '/workers.js'].includes(rel)) return serveFile(res, path.join(WEB, rel.slice(1)));
    if (/^\/sprites\/[a-z0-9-]+\.(png|json)$/.test(rel)) return serveFile(res, path.join(WEB, rel.slice(1)));   // 일꾼 스프라이트시트 + 좌표
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) return send(res, 403, 'text/plain', 'forbidden');
    serveFile(res, file);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({ port: p, base: `http://127.0.0.1:${p}`, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function lanAddrs() {
  try {
    return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  } catch { return []; }
}

function launchdPlist(port, lan) {
  const args = [process.execPath, fileURLToPath(import.meta.url), 'serve', INBOX, '--port', String(port)].concat(lan ? ['--lan'] : []);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.review-sheet.inbox</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>${process.env.REVIEW_SHEET_WORKERS ? `
  <key>EnvironmentVariables</key><dict><key>REVIEW_SHEET_WORKERS</key><string>${esc(process.env.REVIEW_SHEET_WORKERS)}</string></dict>` : ''}
  <key>StandardErrorPath</key><string>${esc(path.join(path.dirname(INBOX), 'inbox.err.log'))}</string>
</dict></plist>
`;
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  if (!cmd) usage();
  // [dir] is optional: `new <name>` / `read <id>` / `wait <id>` / `serve` / `ls` fall back to the inbox.
  const needsArg2 = cmd === 'new' || cmd === 'read' || cmd === 'wait';
  let dirArg = rest[1], arg2 = rest[2];
  if (needsArg2 && rest.length === 2) { arg2 = rest[1]; dirArg = undefined; }
  const dir = path.resolve(dirArg || INBOX);
  const isInbox = !dirArg;
  if (isInbox && cmd !== 'serve') fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });

  if (cmd === 'chat') {
    const [, sub, ch, ...words] = rest;
    const root = INBOX; fs.mkdirSync(chatDir(root), { recursive: true });
    const fmt = m => `${m.ts.replace('T', ' ').slice(0, 16)}  ${m.from === 'hero' ? 'hero' : m.from}: ${m.text}` +
      (m.files || []).map(f => `\n  [이미지] ${chatFilePath(root, ch, f)}`).join('');
    if (sub === 'hub') { if (!ch) { const h = hubChat(root); console.log(h ? h.name : '(허브 없음 — chat hub <ch>)'); return; } setHub(root, ch); console.log(`허브 = ${ch}  → http://127.0.0.1:${INBOX_PORT}/hub`); return; }
    if (sub === 'new') { const m = newChat(root, ch, flags.title, flags.owner, flags.hub || !listChats(root).length); console.log(`${chatLogFile(root, m.name)}\n  → http://127.0.0.1:${INBOX_PORT}/chat.html?c=${m.name}`); return; }
    if (sub === 'ls') { for (const c of listChats(root)) console.log(`${c.hub ? '★' : ''}${c.name}\t${c.owner}\t${c.count}건\thero 미읽 ${c.unreadHero}\t세션 미읽 ${c.unreadOwner}\t${c.title}`); return; }
    if (!ch || !readChatMeta(root, ch)) { console.error(`채널 ${ch || '?'} 없음 — chat new <ch>`); process.exit(1); }
    if (sub === 'say') {
      const text = words[0] === '-' || !words.length ? fs.readFileSync(0, 'utf8').trim() : words.join(' ');
      if (!text) { console.error('text 없음'); process.exit(2); }
      const meta = readChatMeta(root, ch); const m = appendChat(root, ch, meta.owner, text); markSeen(root, ch, 'owner');
      console.log(fmt(m)); return;
    }
    if (sub === 'read' || sub === 'wait') {
      const meta = readChatMeta(root, ch);
      const fresh = () => readChatLog(root, ch).filter(m => m.from === 'hero' && (!meta.seenAt || m.ts > meta.seenAt));
      let msgs = flags.all ? readChatLog(root, ch) : fresh();
      if (sub === 'wait' && !msgs.length) {
        const deadline = Date.now() + (flags.timeout || 3600) * 1000;
        console.error(`waiting for hero on #${ch} (timeout ${flags.timeout || 3600}s)…`);
        while (Date.now() < deadline) { await new Promise(r => setTimeout(r, 2000)); msgs = fresh(); if (msgs.length) break; }
        if (!msgs.length) { console.error('timeout'); process.exit(3); }
      }
      if (flags.json) console.log(JSON.stringify(msgs, null, 2)); else for (const m of msgs) console.log(fmt(m));
      if (!flags.all) markSeen(root, ch, 'owner');
      if (sub === 'read' && !msgs.length) { console.error('(새 메시지 없음)'); process.exitCode = 4; }
      return;
    }
    usage();
  }
  if (cmd === 'install-inbox') {
    const port = flags.port || INBOX_PORT;
    fs.mkdirSync(path.join(INBOX, 'answers'), { recursive: true });
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.review-sheet.inbox.plist');
    fs.writeFileSync(plist, launchdPlist(port, flags.lan !== false));
    console.log(`${plist}\n  → launchctl bootstrap gui/$(id -u) ${plist}   (재설치: bootout 후 bootstrap)\n  → http://127.0.0.1:${port}/`);
    return;
  }
  if (cmd === 'serve') {
    if (isInbox) fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });
    if (!fs.existsSync(dir)) { console.error(`${dir} 없음`); process.exit(1); }
    const host = flags.lan ? '0.0.0.0' : '127.0.0.1';
    const { port } = await startServer(dir, flags.port || (isInbox ? INBOX_PORT : 0), host);
    console.log(`review-sheet: http://127.0.0.1:${port}/  →  answers in ${path.join(dir, 'answers')}`);
    for (const s of listSheets(dir)) if (!s.error) console.log(`  http://127.0.0.1:${port}/sheet.html?d=${s.name}   ${s.title} (${s.picked}/${s.total}${s.submitted ? ' · 제출됨' : ''})`);
    if (flags.lan) for (const a of lanAddrs()) console.log(`  LAN: http://${a}:${port}/`);
    return;
  }
  if (cmd === 'new') {
    if (!arg2 || !ID_RE.test(arg2)) { console.error('name 은 [a-z0-9-]'); process.exit(2); }
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, arg2 + '-data.js');
    if (fs.existsSync(dst)) { console.error(`${dst} 이미 있음`); process.exit(1); }
    const from = process.env.REVIEW_SHEET_FROM || process.env.FLEET_SENDER || process.env.TMUX_PANE && `tmux ${process.env.TMUX_PANE}` || `${os.userInfo().username}@${os.hostname()}`;
    fs.writeFileSync(dst, fs.readFileSync(TEMPLATE, 'utf8')
      .replace(/id: 'example'/, `id: '${arg2}'`)
      .replace(/from: ''/, `from: '${from.replace(/'/g, '')}'`)
      .replace(/createdAt: ''/, `createdAt: '${new Date().toISOString()}'`));
    console.log(dst);
    if (isInbox) {
      console.log(`  → http://127.0.0.1:${INBOX_PORT}/sheet.html?d=${arg2}`);
      for (const a of lanAddrs()) console.log(`  → http://${a}:${INBOX_PORT}/sheet.html?d=${arg2}   (폰·다른 기기: LAN/tailnet)`);
    }
    return;
  }
  if (cmd === 'ls') {
    for (const s of listSheets(dir)) console.log(s.error ? `${s.name}\tERROR ${s.error}` : `${s.name}\t${s.id}\t${s.submitted ? '제출됨' : '대기'}\t${s.picked}/${s.total}\t${s.savedAt || '-'}\t${s.title}`);
    return;
  }
  if (cmd === 'read' || cmd === 'wait') {
    if (!arg2) usage();
    const name = arg2.endsWith('-data.js') ? arg2.slice(0, -'-data.js'.length) : arg2;
    // <id> may be the data-file name or the sheet id; resolve via the data files.
    const found = listSheets(dir).find(s => !s.error && (s.name === name || s.id === name));
    if (!found) { console.error(`${dir} 에 ${name} 시트 없음`); process.exit(1); }
    const sheet = loadSheet(dir, found.name);
    if (cmd === 'wait') {
      const file = answersFile(dir, sheet.id);
      const start = (() => { try { return fs.statSync(file).mtimeMs; } catch { return -1; } })();
      const deadline = Date.now() + (flags.timeout || 3600) * 1000;
      console.error(`waiting for ${file} (timeout ${flags.timeout || 3600}s)…`);
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        let m = -1; try { m = fs.statSync(file).mtimeMs; } catch { /* not yet */ }
        if (m > start) break;
      }
      if (Date.now() >= deadline) { console.error('timeout'); process.exit(3); }
    }
    const saved = readAnswers(dir, sheet.id);
    if (flags.json) console.log(JSON.stringify(saved, null, 2));
    else console.log(renderMarkdown(sheet, saved));
    if (cmd === 'read' && !saved) process.exitCode = 4;
    return;
  }
  usage();
}

const entry = process.argv[1] && fs.realpathSync(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message || e); process.exit(1); });
