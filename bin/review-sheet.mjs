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
 *   review-sheet assign <dir> <id> <issue> <owner>   record who owns a submitted sheet's follow-up (closes it)
 *   review-sheet stage <dir> <id> <stage> [note…]    the owner reports a step (머지·배포대기·라이브·끝, --off --eta) — shown as a tag at the front of the sheet's row
 *   review-sheet unassigned <dir> [--prefix P] [--hours N]  submitted sheets with no owner / answer changed / stalled N h (exit 5 if any)
 *
 * <dir> may be omitted everywhere: it then defaults to the INBOX (~/.review-sheet/inbox, or $REVIEW_SHEET_INBOX),
 * one folder every session drops its sheets into, served once (port 5600) like a queue — pending sheets on top,
 * submitted ones marked and listed below. `review-sheet install-inbox` registers that server with launchd (macOS).
 *
 * Layout of <dir> (the sheet dir, usually `review/` inside the repo):
 *   <name>-data.js      one sheet: `window.SHEET = { id, title, sections:[{ code, questions:[…] }] }`
 *   answers/<id>.json   what the reviewer saved: { sheet, answers:{ "<code>-<k>": { pick, memo, files:[{name,orig}] } }, savedAt }
 *   answers/<id>.files/ files the reviewer attached to a question (page: 📎·paste·drop → POST /__answers/file), served at /answers/<id>.files/<name>
 *   assign/<id>.json    { issue, owner, at, stages:[{stage,note,at,by}], heroSeenAt } written by `assign`/`stage`, page 확인 → heroSeenAt; assign/.since = when the gate started (older answers are exempt)
 *   anything else       images etc. the sheet references by relative path
 *
 * 음성 입력: POST /api/stt[?live=1&from=초] (audio/* 바디) → ffmpeg → whisper.cpp(whisper-cli) 로 **로컬에서만** 전사해 { text, end } 를 돌려준다(live = 말하는 중 미리보기).
 *   모델 ~/.review-sheet/models/ggml-large-v3-turbo.bin · 단어장 ~/.review-sheet/vocab.txt(한 줄 1단어 → --prompt).
 *   env 로 교체: REVIEW_SHEET_WHISPER_BIN / _WHISPER_MODEL / _FFMPEG / _VOCAB / _STT_LANG(기본 ko). 오디오는 외부로 나가지 않는다.
 *
 * No dependencies. Node 18+.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
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
  review-sheet assign [dir] <id> <issue#> <owner>   # 제출된 시트의 후속 일 담당 기록 → 닫힘
  review-sheet stage [dir] <id> <머지|배포대기|라이브|끝> [--off] [--eta <언제>] [메모…]   # 담당 세션이 끝난 상태 보고 → 시트 줄 맨 앞 태그
  review-sheet checks [dir] [--open] [--since ISO] [--prefix P]   # 보고 시트(report:) — hero 가 ✓ 확인한 것 / --open 아직 안 한 것. 체크는 세션을 깨우지 않는다
  review-sheet unassigned [dir] [--prefix P] [--hours N]  # 담당 없음·배정 뒤 답 바뀜·N시간(기본 24) 단계 멈춤 시트 — 있으면 exit 5
  review-sheet board [dir] [<file|->]   # 진행판(보기 전용) — board.json {cards:[{title,status:todo|doing|done,priority,owner,mode:claude|system|idle,modeNote,url}]} 쓰기, 인자 없으면 요약
  review-sheet install-inbox [--port N]      # launchd: serve the inbox on boot (macOS)
  review-sheet chat new  <ch> [--title T] [--owner <session>] [--hub]   # 상시 채널 (inbox/chat/<ch>.jsonl) — hero ↔ 세션 메신저. 첫 채널 = 자동 허브
  review-sheet chat hub  [<ch>]                                  # 메인 허브 채널 보기/지정 — 받은편지함 맨 위 고정, /hub 가 그 채널로
  review-sheet chat ls | read <ch> [--all] [--json] | say <ch> [--re <id>] [--notice] <text…|-> | wait <ch> [--timeout SEC]   # --re = 그 메시지에 답장(카톡식 인용)
  (메모: http://127.0.0.1:${INBOX_PORT}/memo.html — hero 가 자기한테 보내는 메시지, CLI 없음·세션은 읽지 않는다)
  [dir] omitted → inbox ${INBOX} (one folder for every session; served on :${INBOX_PORT})`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan' || a === '--json' || a === '--all' || a === '--hub' || a === '--off' || a === '--notice' || a === '--open') flags[a.slice(2)] = true;
    else if (a === '--port' || a === '--timeout' || a === '--hours') flags[a.slice(2)] = Number(argv[++i]);
    else if (a === '--title' || a === '--owner' || a === '--re' || a === '--prefix' || a === '--eta' || a === '--since') flags[a.slice(2)] = String(argv[++i] || '');
    else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); usage(); }
    else rest.push(a);
  }
  return { flags, rest };
}

/** Chat is for short notices; anything hero must look at or confirm belongs on a sheet (hero 2026-10-14).
 *  Returns why a chat message looks like review material, or null. `chat say --notice` skips it. */
export function chatGate(text) {
  if (/https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}:\d+/.test(text)) return '링크가 들어 있음';
  if (/말씀\s*(해\s*)?주세요|알려\s*주세요|확인\s*(해\s*)?주세요|봐\s*주세요|골라\s*주세요|정해\s*주세요|컨펌|괜찮은지|괜찮을까요|어떠세요|어떤가요|할까요\?|될까요\?|맞나요\?/.test(text)) return '확인·결정 요청이 들어 있음';
  if (text.length > 500) return `긴 글(${text.length}자 — 결과 보고는 시트로)`;
  return null;
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

/* 배정 게이트 (hero 2026-10-13 "정한 일이 빠지지 않게") — 제출된 시트는 후속 일을 맡을 이슈#·담당 창이 적혀야 닫힌다.
   assign/<id>.json { issue, owner, at }. 게이트를 처음 쓴 시각을 assign/.since 에 남겨, 그 전에 답한 옛 시트는 대상에서 뺀다.
   배정 뒤 hero 가 답을 바꾸면(savedAt > at) 다시 열린다 — 바뀐 답도 누군가 받아야 하니까. */
const assignDir = dir => path.join(dir, 'assign');
export function readAssign(dir, id) { try { return JSON.parse(fs.readFileSync(path.join(assignDir(dir), id + '.json'), 'utf8')); } catch { return null; } }
export function assignSince(dir) {
  const f = path.join(assignDir(dir), '.since');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* first use */ }
  const now = new Date().toISOString();
  fs.mkdirSync(assignDir(dir), { recursive: true }); fs.writeFileSync(f, now + '\n');
  return now;
}
const saveAssign = (dir, id, rec) => fs.writeFileSync(path.join(assignDir(dir), id + '.json'), JSON.stringify(rec, null, 2) + '\n');
export function writeAssign(dir, id, issue, owner, by = fromId()) {
  assignSince(dir);
  const old = readAssign(dir, id) || {}, at = new Date().toISOString();
  const rec = { ...old, issue: String(issue), owner: String(owner), at,
    stages: [...(old.stages || []), { stage: '배정', note: `${issue} → ${owner}`, at, by }] };
  saveAssign(dir, id, rec);
  return rec;
}

/* 단계 보고 (hero 2026-10-13 "시트로 가져간 일은 끝나면 항상 보고") — 배정 뒤 담당 세션이 머지·배포대기·라이브·끝 을 한 줄 메모와 함께 남긴다.
   받은편지함 '제출됨' 목록의 그 시트 줄 맨 앞에 태그로 붙고, 단계가 바뀐 시트는 위로 올라온다. 답할 필요는 없다. */
export const STAGES = { 머지: '머지', merged: '머지', 배포대기: '배포대기', deploy: '배포대기', 라이브: '라이브', live: '라이브', 끝: '끝', done: '끝' };
export const FINAL_STAGES = new Set(['라이브', '끝']);
export function fromId() {
  return process.env.REVIEW_SHEET_FROM || process.env.FLEET_SENDER || process.env.TMUX_PANE && `tmux ${process.env.TMUX_PANE}` || `${os.userInfo().username}@${os.hostname()}`;
}
/** 시트 줄 맨 앞 태그 — 끝난 일이 '어떻게' 끝났는지 (hero 2026-10-14: 메인만? 배포 큐? 배포됨? 어드민 스위치 꺼짐? 언제 공개?)
    off = 코드는 들어갔지만 어드민 스위치가 꺼져 있어 켜야 보임, eta = 배포·공개 예정(시각 또는 '다음 시즌' 같은 말). */
export function stageTag(x) {   // 아이콘 + 한 단어 (hero 2026-10-15 "문장 너무 길어 — 아이콘+ 간결하게 머지됨")
  const off = x.off ? ' · 스위치 꺼짐' : '', eta = x.eta ? ' · ' + x.eta + (x.stage === '라이브' ? ' 공개' : ' 예정') : '';
  switch (x.stage) {
    case '머지': return '🔀 머지됨' + off + eta;
    case '배포대기': return '⏳ 배포 대기' + off + eta;
    case '라이브': return '🚀 배포됨' + (x.off ? off + eta : '');
    case '끝': return '✅ 끝';
    default: return x.stage;
  }
}
/* 보고 시트 (hero 2026-10-15) — 결정할 게 없는 알림(머지·배포·끝). 시트 데이터에 report: 'merged'|'deployed'|'done'|'note'
   (또는 '머지'·'배포'·'끝'·'보고'). 받은편지함 줄·시트 맨 위에 아이콘+한 단어 배지, 제출 대신 ✓ 확인 체크.
   체크는 answers 가 아니라 inbox/checked.json 에만 남는다 → wait 가 안 깨고 세션 토큰을 안 쓴다. 세션은 나중에 `checks` 로 한 번에 본다.
   report 가 없는 옛 시트도 제목이 '✅ 머지했습니다 — …' 처럼 시작하면 보고로 보고, 그 긴 머리는 배지로 옮긴다. */
export const REPORTS = { merged: '🔀 머지됨', deployed: '🚀 배포됨', done: '✅ 끝남', note: '📌 보고' };
const REPORT_ALIAS = { 머지: 'merged', 배포: 'deployed', 끝: 'done', 보고: 'note' };
const REPORT_TITLE = [
  [/^\s*(?:(?:✅|🔀|📌)\s*)?머지(?:했습니다|되었습니다|됨|완료)\s*[—:·-]?\s*/, 'merged'],
  [/^\s*(?:(?:✅|🚀|📌)\s*)?배포(?:했습니다|되었습니다|됨|완료)\s*[—:·-]?\s*/, 'deployed'],  [/^\s*(?:📌\s*)?(?:이렇게\s*)?해\s*놓겠습니다\s*[—:·-]?\s*/, 'note'],
];
const PLAN_RE = /해\s*놓겠습니다/;
/** 결정할 게 있는 시트: 첫 선택지가 '확인'·'그대로' 류가 아닌 질문이 있거나, lede·제목에 승인 요청.
 *  '이렇게 해놓겠습니다'는 답 기다림이 아니라 보고(hero 2026-10-15 "진행해놓고") — 고를 질문이 없으면 📌 보고. */
const decides = sheet => /승인 요청/.test(String(sheet.title || '') + String(sheet.lede || '')) ||
  (sheet.sections || []).some(s => (s.questions || []).some(q => { const o = Array.isArray(q) ? q[2] : q.opts; const f = o && o[0]; const l = Array.isArray(f) ? f[0] : f; return l && !/확인|그대로/.test(String(l)); }));
export function reportOf(sheet) {
  const t = String(sheet.title || sheet.id || '');
  let kind = sheet.report ? (REPORTS[sheet.report] ? sheet.report : REPORT_ALIAS[sheet.report] || 'note') : '', title = t;
  // 제목만 보고 고를 땐 결정할 게 없는 시트만 — '머지했습니다 · 이렇게 해놓겠습니다'(승인 요청)가 ✓ 로 끝나면 세션이 답을 못 받는다
  if (!kind && decides(sheet)) return null;
  for (const [re, k] of REPORT_TITLE) if (re.test(t)) { title = t.replace(re, '') || t; kind = kind || k; break; }
  if (!kind && PLAN_RE.test(t + String(sheet.lede || ''))) kind = 'note';
  return kind ? { kind, label: REPORTS[kind], title } : null;
}
const checkedFile = dir => path.join(dir, 'checked.json');
export function readChecked(dir) { try { return JSON.parse(fs.readFileSync(checkedFile(dir), 'utf8')) || {}; } catch { return {}; } }
export function setChecked(dir, name, on) {
  const s = listSheets(dir).find(x => !x.error && x.name === name); if (!s) throw new Error(`시트 ${name} 없음`);
  if (!s.report) throw new Error(`${name}: 보고 시트가 아님 (report 없음)`);
  const c = readChecked(dir);
  if (on) c[name] = c[name] || new Date().toISOString(); else delete c[name];
  fs.writeFileSync(checkedFile(dir) + '.tmp', JSON.stringify(c, null, 2) + '\n'); fs.renameSync(checkedFile(dir) + '.tmp', checkedFile(dir));
  return { ok: true, name, checkedAt: c[name] || null };
}
export function writeStage(dir, id, stage, note = '', by = fromId(), opt = {}) {
  const st = STAGES[stage];
  if (!st) throw new Error(`단계는 ${[...new Set(Object.values(STAGES))].join(' · ')} 중 하나 (받은 값: ${stage})`);
  const a = readAssign(dir, id);
  if (!a) throw new Error(`${id}: 아직 배정 안 됨 — 먼저 assign <시트> <이슈#> <담당>`);
  const rec = { stage: st, note: String(note), at: new Date().toISOString(), by };
  if (opt.off) rec.off = true;
  if (opt.eta) rec.eta = String(opt.eta).slice(0, 60);
  a.stages = [...(a.stages || [{ stage: '배정', note: `${a.issue} → ${a.owner}`, at: a.at }]), rec];
  saveAssign(dir, id, a);
  return a;
}
/** 시트 요약에 붙일 배정·단계 정보 — tag 는 받은편지함 시트 줄 맨 앞에 붙는 '끝난 상태'. */
function assignInfo(a) {
  if (!a) return null;
  const last = (a.stages || []).at(-1) || { stage: '배정', note: `${a.issue} → ${a.owner}`, at: a.at };
  return { issue: a.issue, owner: a.owner, stage: last.stage, tag: stageTag(last), off: !!last.off, eta: last.eta || '', note: last.note || '', stageAt: last.at, by: last.by || '' };
}
/** 'none' = 제출됐는데 배정 없음 · 'changed' = 배정 뒤 답이 바뀜 · 'ok' = 배정됨 · null = 대상 아님(미제출·게이트 전 답) */
export function assignState(dir, s, since, stallHours = 24) {
  if (!s || s.error || !s.submitted) return null;
  const a = readAssign(dir, s.id);
  if (a) {
    if (String(s.savedAt) > String(a.at)) return 'changed';
    const i = assignInfo(a);
    return !FINAL_STAGES.has(i.stage) && Date.now() - Date.parse(i.stageAt) > stallHours * 3600e3 ? 'stalled' : 'ok';
  }
  return String(s.savedAt) >= String(since) ? 'none' : null;
}
/* Sheet attachments: any file type (hero 2026-10-06 "리뷰 시트에도 파일 첨부"), stored under a random name so the
   original name never reaches the disk path; the original is kept beside it in the answers JSON as `orig`. */
export const sheetFilePath = (dir, id, name) => path.join(dir, 'answers', id + '.files', name);
const SHEET_FILE_RE = /^[a-z0-9]{6,32}\.[a-z0-9]{1,8}$/;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf', 'text/plain': 'txt' };
// 진행판 — 바깥 생산자(예: fleet)가 만든 board.json 을 그대로 보여 주는 보기 전용 층. 판은 일을 고치지 않는다.
export const BOARD_STATUS = ['todo', 'doing', 'done'], BOARD_MODES = ['claude', 'system', 'idle'];
export const boardFile = dir => path.join(dir, 'board.json');
export function cleanBoard(j) {
  if (!j || !Array.isArray(j.cards)) throw new Error('board: {cards:[…]} 필요');
  const str = (v, n = 300) => typeof v === 'string' ? v.slice(0, n) : undefined;
  const cards = j.cards.filter(c => c && typeof c.title === 'string' && c.title.trim()).map(c => ({
    id: str(c.id, 80), title: c.title.trim().slice(0, 300), url: /^https?:\/\//.test(c.url || '') ? str(c.url, 500) : undefined,
    status: BOARD_STATUS.includes(c.status) ? c.status : 'todo', priority: str(c.priority, 20), group: str(c.group, 40),
    owner: (Array.isArray(c.owner) ? c.owner : c.owner ? [c.owner] : []).filter(o => typeof o === 'string').map(o => o.slice(0, 60)).slice(0, 8),
    mode: BOARD_MODES.includes(c.mode) ? c.mode : undefined, modeNote: str(c.modeNote, 120), note: str(c.note, 300), at: str(c.at, 40),
  }));
  return { title: str(j.title, 80), source: str(j.source, 80), updatedAt: str(j.updatedAt, 40) || new Date().toISOString(), cards };
}
export function writeBoard(dir, j) {
  const b = cleanBoard(j), f = boardFile(dir), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 1)); fs.renameSync(tmp, f);
  return b;
}
export function readBoard(dir) { try { return JSON.parse(fs.readFileSync(boardFile(dir), 'utf8')); } catch { return null; } }

export function saveSheetFile(dir, id, type, orig, buf) {
  if (!buf.length) throw new Error('빈 파일');
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(orig || ''));
  const ext = m ? m[1].toLowerCase() : (MIME_EXT[String(type || '').split(';')[0].trim().toLowerCase()] || 'bin');
  fs.mkdirSync(path.dirname(sheetFilePath(dir, id, 'x')), { recursive: true });
  const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
  fs.writeFileSync(sheetFilePath(dir, id, name), buf); return name;
}
/* Keep only attachments that really exist under this sheet; trim the original name to something printable. */
function cleanFiles(dir, id, files) {
  return (Array.isArray(files) ? files : []).filter(f => f && typeof f.name === 'string' && SHEET_FILE_RE.test(f.name) && fs.existsSync(sheetFilePath(dir, id, f.name)))
    .map(f => ({ name: f.name, orig: String(f.orig || f.name).replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 120) }));
}

export function readAnswers(dir, id) {
  try { return JSON.parse(fs.readFileSync(answersFile(dir, id), 'utf8')); } catch { return null; }
}

/** Normalise a question (object form or the older tuple [k, q, opts, rec, why]). */
export function normQ(q) {
  if (Array.isArray(q)) return { k: String(q[0]), q: q[1], opts: (q[2] || []).map(o => Array.isArray(o) ? o : [o]), rec: q[3] || '', why: q[4] || '' };
  return { ...q, k: String(q.k), opts: (q.opts || []).map(o => Array.isArray(o) ? o : [o]), rec: q.rec || '', why: q.why || '' };
}

/** Answers joined with the questions, as markdown the session pastes into the SoT. */
export function renderMarkdown(sheet, saved, dir) {
  const A = (saved && saved.answers) || {};
  const out = [`## ${sheet.title || sheet.id} — 답변`, ''];
  out.push(saved && saved.savedAt ? `저장 ${saved.savedAt} · sheet \`${sheet.id}\`` : `(아직 저장된 답변 없음) · sheet \`${sheet.id}\``, '');
  if (askOf(saved)) out.push(`> **hero 추가 질문** — 채팅으로 답할 것: ${askOf(saved).replace(/\n/g, ' ')}`, '');
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
      out.push(`| ${q.k} | ${cell(q.q)} | ${cell(pick)} | ${cell(a.memo || '')}${a.files && a.files.length ? ` 📎${a.files.length}` : ''} |`);
    }
    const m = A[`${s.code}-memo`];
    if (m && m.memo) out.push('', `> 전체 메모: ${m.memo.replace(/\n/g, ' ')}`);
    const att = Object.keys(A).filter(k => k.startsWith(`${s.code}-`) && A[k].files && A[k].files.length);
    if (att.length) out.push('', ...att.flatMap(k => A[k].files.map(f => `- 📎 ${k}: ${f.orig} → ${dir ? sheetFilePath(path.resolve(dir), sheet.id, f.name) : `answers/${sheet.id}.files/${f.name}`}`)));
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

/* 🔥 긴급 (hero 2026-10-08) — 시트만, 켜짐/꺼짐 두 단계, 켜고 끄는 건 hero(받은편지함 🔥 버튼)만.
   inbox/urgent.json { "<data 파일 이름>": "<켠 시각>" }. 켜면 '답 기다리는 중' 맨 위, 담당 세션 채널에 hero 이름으로 알림이 간다. */
const urgentFile = dir => path.join(dir, 'urgent.json');
export function readUrgent(dir) { try { return JSON.parse(fs.readFileSync(urgentFile(dir), 'utf8')) || {}; } catch { return {}; } }
/** 시트 → 담당 세션의 채널: from 과 이름/owner 가 같은 채널, 없으면(데이터 파일을 통째로 덮어써 from 이 빠진 경우) 시트 이름 접두가 가장 긴 채널 */
function chatFor(root, from, sheetName) {
  const all = listChats(root);
  if (from) { const c = all.find(c => c.name === from) || all.find(c => c.owner === from || String(c.owner).split(':')[0] === from); if (c) return c; }
  return all.filter(c => String(sheetName).startsWith(c.name + '-')).sort((a, b) => b.name.length - a.name.length)[0] || null;
}
/* 추가 질문 (hero 2026-10-13) — answers._ask.memo. 새로 쓰거나 바뀌면 담당 세션 채널에 hero 이름으로 알림, read 맨 위에 뜬다. */
const askOf = saved => (saved && saved.answers && saved.answers._ask && typeof saved.answers._ask.memo === 'string' && saved.answers._ask.memo.trim()) || '';
function notifyAsk(root, id, text) {
  const s = listSheets(root).find(x => !x.error && x.id === id); if (!s) return null;
  const c = chatFor(path.resolve(root), s.from, s.name); if (!c) return null;
  appendChat(path.resolve(root), c.name, 'hero', `추가 질문 (시트 ${s.name} · ${s.title}): ${text}\n— 채팅으로 답할 것. 답이 일을 바꾸면 SoT 이슈에도 한 줄.`);
  return c.name;
}

export function setUrgent(dir, name, on) {
  const s = listSheets(dir).find(x => !x.error && x.name === name); if (!s) throw new Error(`시트 ${name} 없음`);
  const u = readUrgent(dir), was = !!u[name];
  if (on) u[name] = u[name] || new Date().toISOString(); else delete u[name];
  fs.writeFileSync(urgentFile(dir) + '.tmp', JSON.stringify(u, null, 2) + '\n'); fs.renameSync(urgentFile(dir) + '.tmp', urgentFile(dir));
  let notified = null;
  if (was !== !!on) {
    const c = chatFor(path.resolve(dir), s.from, s.name);
    if (c) {
      appendChat(path.resolve(dir), c.name, 'hero', on
        ? `🔥 긴급 지정: ${s.title} (시트 ${s.name}) — 하던 일을 안전한 지점까지만 정리하고 이 일부터 처리. SoT 이슈가 있으면 긴급 라벨.`
        : `긴급 해제: ${s.title} (시트 ${s.name}) — 평소 순서로. SoT 이슈의 긴급 라벨 제거.`);
      notified = c.name;
    }
  }
  return { ok: true, name, urgent: !!on, notified };
}
/* 시트 요약 캐시 (hero 2026-10-11 "리뷰시트 느려졌어") — 시트가 500개를 넘자 받은편지함을 열 때마다(그리고 5초 새로고침마다)
   모든 data.js 를 vm 으로 돌리고 answers 를 읽어 1초 넘게 걸렸다. data.js·answers 의 mtime 이 그대로면 지난 요약을 쓴다. */
const summaryCache = new Map();   // <dir>/<name> → { key, sum }
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
function listSheetsRaw(dir) {
  const urgent = readUrgent(dir), checked = readChecked(dir);
  const live = (name, sum) => ({ ...sum, urgent: !!urgent[name], urgentAt: urgent[name] || null, checkedAt: sum.report && checked[name] || null });
  return fs.readdirSync(dir).filter(f => f.endsWith('-data.js')).sort().map(f => {
    const name = f.slice(0, -'-data.js'.length);
    const ck = path.join(path.resolve(dir), name), hit = summaryCache.get(ck), dataM = mtimeOf(path.join(dir, f));
    if (hit && hit.dataM === dataM && (hit.sum.error || hit.ansM === mtimeOf(answersFile(dir, hit.sum.id))))
      return hit.sum.error ? hit.sum : live(name, hit.sum);
    try {
      const sheet = loadSheet(dir, name);
      const saved = readAnswers(dir, sheet.id);
      const qs = sheet.sections.flatMap(s => (s.questions || []).map(q => `${s.code}-${normQ(q).k}`));
      const picked = qs.filter(k => saved && saved.answers && saved.answers[k] && (saved.answers[k].pick || saved.answers[k].memo || (saved.answers[k].files || []).length)).length;
      let createdAt = sheet.createdAt || null;
      if (!createdAt) { try { createdAt = fs.statSync(path.join(dir, f)).mtime.toISOString(); } catch { /* ignore */ } }
      const savedAt = saved && saved.savedAt || null;
      const rep = reportOf(sheet);
      const sum = { name, id: sheet.id, title: rep ? rep.title : sheet.title || sheet.id, from: sheet.from || '', createdAt,
               total: qs.length, picked, savedAt, submitted: !!savedAt, report: rep ? rep.label : '' };
      summaryCache.set(ck, { dataM, ansM: mtimeOf(answersFile(dir, sheet.id)), sum });
      return live(name, sum);
    } catch (e) { const sum = { name, error: String(e.message || e) }; summaryCache.set(ck, { dataM, sum }); return sum; }
  }).sort((a, b) => {
    // queue order: errors first (they need fixing), then pending (newest first), then submitted (latest first)
    const g = x => x.error ? 0 : x.submitted ? 2 : 1;
    if (g(a) !== g(b)) return g(a) - g(b);
    if (!!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1;   // 🔥 긴급은 자기 묶음 맨 위
    return String(g(a) === 2 ? b.savedAt : b.createdAt || '').localeCompare(String(g(a) === 2 ? a.savedAt : a.createdAt || ''));
  });
}

function listSheets(dir) {   // 배정·단계는 자주 바뀌고 파일이 몇 개 안 되니 캐시 밖에서 붙인다
  let names = []; try { names = fs.readdirSync(assignDir(dir)).filter(f => f.endsWith('.json')); } catch { /* 게이트 안 씀 */ }
  const by = new Map(names.map(f => [f.slice(0, -5), f]));
  return listSheetsRaw(dir).map(s => s.error || !by.has(s.id) ? s : { ...s, assign: assignInfo(readAssign(dir, s.id)) });
}

/* 받은편지함 첫 화면: 답 기다리는 시트는 전부, 제출된 시트는 최근 RECENT_DONE 개만. 나머지는 '지난 시트 더 보기'(all=1) 때. */
const RECENT_DONE = 20;
function inboxSheets(dir, all) {
  const handled = s => !s.error && (s.submitted || !!s.checkedAt);   // 보고 시트는 ✓ 확인 체크도 끝남
  const sheets = listSheets(dir), done = sheets.filter(handled);
  // 제출된 시트는 마지막 움직임(제출·확인 또는 단계 보고) 최신순 — 상태가 바뀐 시트가 위로 (hero 2026-10-14)
  const act = s => { const t = String(s.checkedAt && !(s.savedAt > s.checkedAt) ? s.checkedAt : s.savedAt); return String(s.assign && s.assign.stageAt > t ? s.assign.stageAt : t); };
  done.sort((a, b) => (!!b.urgent - !!a.urgent) || act(b).localeCompare(act(a)));
  const open = sheets.filter(s => !handled(s));
  return { sheets: open.concat(all ? done : done.slice(0, RECENT_DONE)), doneTotal: done.length, all: !!all || done.length <= RECENT_DONE };
}

/* ── 상시 채널 (chat) ───────────────────────────────────────────────────────────
   inbox/chat/<ch>.json   meta  { name, title, owner, createdAt, seenAt (owner read up to), heroSeenAt }
   inbox/chat/<ch>.jsonl  one message per line { id, ts, from: 'hero'|<owner>, text, files?: [name], re?: id }
   re = reply (카톡식 답글): the id of an earlier message in the same channel. Optional — only when the message answers one
   specific earlier message; the page shows the quoted original on top of the bubble and tapping it jumps there.
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
const MSG_ID_RE = /^[a-z0-9]{6,24}$/;
export function appendChat(root, ch, from, text, files, re) {
  const meta = readChatMeta(root, ch); if (!meta) throw new Error(`채널 ${ch} 없음`);
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), from, text: String(text) };
  if (files && files.length) msg.files = files;
  const log = readChatLog(root, ch);
  if (re) { if (!MSG_ID_RE.test(String(re)) || !log.some(m => m.id === re)) throw new Error(`답장 원문 ${re} 없음 — chat read ${ch} --all 의 #id`); msg.re = String(re); }
  const last = log.at(-1);   // same sender + same text + same files within 3s = a double send, keep the first
  if (last && last.from === from && last.text === msg.text && (last.re || null) === (msg.re || null) && JSON.stringify(last.files || []) === JSON.stringify(msg.files || []) && Date.now() - Date.parse(last.ts) < 3000) return last;
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
  }).filter(Boolean).sort((a, b) => (b.hub - a.hub) || (!!b.manager - !!a.manager));   // 허브 → 매니저(meta.manager, 일 분배 세션) → 일반
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
  const last = readMemo(root, name).messages.at(-1);   // same text within 3s = a double send
  if (last && last.text === text && Date.now() - Date.parse(last.ts) < 3000) return last;
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

/* ── 음성 입력 (STT, 로컬 whisper.cpp) ───────────────────────────────────────────
   launchd 의 PATH 는 /usr/bin:/bin 뿐이라 brew 경로를 직접 찾는다. 설정은 요청마다 env 에서 읽는다(테스트·교체용). */
const STT_DIR = path.join(os.homedir(), '.review-sheet');
const STT_MAX_BYTES = 25 * 1024 * 1024;
function which(name) {
  const dirs = (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin']);
  for (const d of dirs) {
    if (!d) continue;   // empty PATH entry = cwd (launchd: often /) — would match a directory like Cellar/ffmpeg
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}
export function sttConfig() {
  const vocabFile = process.env.REVIEW_SHEET_VOCAB || path.join(STT_DIR, 'vocab.txt');
  let vocab = [];
  try { vocab = fs.readFileSync(vocabFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); } catch { /* optional */ }
  return {
    whisper: process.env.REVIEW_SHEET_WHISPER_BIN || which('whisper-cli'),
    ffmpeg: process.env.REVIEW_SHEET_FFMPEG || which('ffmpeg'),
    model: process.env.REVIEW_SHEET_WHISPER_MODEL || path.join(STT_DIR, 'models', 'ggml-large-v3-turbo.bin'),
    lang: process.env.REVIEW_SHEET_STT_LANG || 'ko',
    vocabFile, vocab,
  };
}
export function sttStatus(c = sttConfig()) {
  const missing = [];
  if (!c.whisper) missing.push('whisper-cli (brew install whisper-cpp)');
  if (!c.ffmpeg) missing.push('ffmpeg (brew install ffmpeg)');
  if (!fs.existsSync(c.model)) missing.push('model ' + c.model);
  return { ready: !missing.length, missing, model: path.basename(c.model), lang: c.lang, vocab: c.vocab.length };
}
const run = (bin, args, timeout) => new Promise((resolve, reject) =>
  execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? reject(new Error(`${path.basename(bin)}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`)) : resolve(stdout)));
/** 16-bit mono wav 가 거의 무음인가 (RMS < ~-45dBFS) */
function quiet(wav) {
  const b = fs.readFileSync(wav); let sum = 0, n = 0;
  for (let i = 44; i + 1 < b.length; i += 2) { const v = b.readInt16LE(i); sum += v * v; n++; }
  return !n || Math.sqrt(sum / n) < 180;
}
/* whisper 가 무음·잡음에 지어내는 말(유튜브 자막 학습 흔적, hero 2026-10-15 "계속 감사합니다가 찍혀").
   전사 전체가 이것뿐이면 버리고, 진짜 말 끝에 붙은 방송 인사(시청·구독)는 떼어낸다. ‘감사합니다’ 는 진짜 말일 수 있어 혼자일 때만 버린다. */
const HALLU_ONLY = /^(?:(?:감사합니다|고맙습니다|네|아|음|MBC 뉴스 [가-힣]+입니다|시청해\s*주셔서 감사합니다|구독과 좋아요(?: 부탁드립니다)?|다음 영상에서 만나요|자막 제공[^.!?]*)[.!?~\s]*)+$/;
const HALLU_TAIL = /\s*(?:시청해\s*주셔서 감사합니다|구독과 좋아요(?: 부탁드립니다)?|다음 영상에서 만나요)[.!?~\s]*$/;
const editDist = (a, b) => { const d = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } }
  return d[b.length]; };
/* 잡음에 단어장(--prompt)을 그대로 읊는 경우 — "히어로, 플릿, 에피어로, 플릿". 쉼표로 늘어놓은 낱말이 전부 단어장 낱말(또는 3자 이상이면 2자 이내로 비슷)일 때만 버린다. */
const vocabEcho = (t, vocab) => {
  if (!vocab.length || !t.includes(',')) return false;
  const w = t.split(/[,.\s]+/).filter(Boolean);
  return w.length > 0 && w.every(x => vocab.includes(x) || (x.length >= 3 && vocab.some(v => v.length >= 2 && editDist(x, v) <= 2)));
};
export function dropHallucination(text, vocab = []) {
  const t = String(text || '').trim();
  if (!t || HALLU_ONLY.test(t) || vocabEcho(t, vocab)) return '';
  return t.replace(HALLU_TAIL, '').trim();
}
const sttThreads = () => String(Math.max(4, Math.min(8, os.cpus().length - 2)));
/* 상주 whisper-server — whisper-cli 는 부를 때마다 모델을 새로 읽느라 2초쯤 쓴다(3초 말도 3초 걸림). whisper-cli 옆에 whisper-server 가
   있으면 127.0.0.1 빈 포트에 한 번 띄워 두고 재사용(짧은 말 ~0.8초), 10분 놀면 내린다(메모리). 없거나 실패하면 whisper-cli 로 떨어진다. */
const WS_IDLE_MS = 10 * 60e3;
let ws = null;   // { key, proc, port, ready, idle }
function wsStop() { if (!ws) return; clearTimeout(ws.idle); try { ws.proc.kill(); } catch { /* gone */ } ws = null; }
process.on('exit', wsStop);
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
export async function sttServer(c = sttConfig()) {
  const bin = c.whisper && path.join(path.dirname(c.whisper), 'whisper-server');
  if (!bin || !fs.existsSync(bin)) return null;
  const key = [bin, c.model, c.lang].join('|');
  if (ws && ws.key !== key) wsStop();
  if (!ws) {
    const port = await freePort();
    const proc = spawn(bin, ['-m', c.model, '-l', c.lang, '-t', sttThreads(), '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
    const me = ws = { key, proc, port };
    proc.on('exit', () => { if (ws === me) ws = null; });
    proc.on('error', () => { if (ws === me) ws = null; });
    me.ready = (async () => {
      for (let i = 0; i < 240; i++) {
        if (ws !== me) throw new Error('whisper-server 종료');
        try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return; } catch { /* still loading */ }
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error('whisper-server 기동 시간 초과');
    })();
  }
  const me = ws;
  clearTimeout(me.idle); me.idle = setTimeout(() => { if (ws === me) wsStop(); }, WS_IDLE_MS); me.idle.unref();
  try { await me.ready; return me; } catch { if (ws === me) wsStop(); return null; }
}
async function sttServerInfer(me, wav, c, live) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'in.wav');
  fd.append('response_format', 'text'); fd.append('language', c.lang);
  fd.append('beam_size', live ? '1' : '5'); fd.append('best_of', live ? '1' : '5');
  if (c.vocab.length && !live) fd.append('prompt', c.vocab.join(', '));   // 짧은 조각에 단어장을 주면 단어장을 그대로 읊는다
  const r = await fetch(`http://127.0.0.1:${me.port}/inference`, { method: 'POST', body: fd, signal: AbortSignal.timeout(300e3) });
  if (!r.ok) throw new Error('whisper-server HTTP ' + r.status);
  return r.text();
}

let sttQueue = Promise.resolve();   // one transcription at a time — whisper already uses every core
/** audio bytes (any ffmpeg-readable container: webm/opus, mp4/aac, wav…) → { text, end }. Local only.
 *  live = 말하는 중 미리보기: 쌓인 녹음 전체를 받아 from 초 이후만 빠르게(greedy) 적는다 — end(초)를 돌려줘 다음 from 이 된다. */
export function transcribe(buf, c = sttConfig(), { from = 0, live = false } = {}) {
  const job = sttQueue.then(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-stt-'));
    try {
      const inp = path.join(tmp, 'in.bin'), wav = path.join(tmp, 'in.wav');
      fs.writeFileSync(inp, buf);
      await run(c.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inp, ...(from > 0 ? ['-ss', String(from)] : []), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60e3);
      const sec = Math.max(0, (fs.statSync(wav).size - 44) / 32000), end = Math.round((from + sec) * 100) / 100;
      if (live && sec < 0.8) return { text: '', end: from };   // 새로 쌓인 소리가 너무 짧다 — 다음 번에
      if (quiet(wav)) return { text: '', end };                  // 조용한 녹음·조각 — whisper 가 ‘감사합니다’ 를 지어낸다(최종 전사도)
      let out = null;
      const srv = await sttServer(c).catch(() => null);
      if (srv) out = await sttServerInfer(srv, wav, c, live).catch(() => null);
      if (out == null) {
        const args = ['-m', c.model, '-f', wav, '-l', c.lang, '-nt', '-np', '-t', sttThreads(), ...(live ? ['-bs', '1', '-bo', '1'] : [])];
        if (c.vocab.length && !live) args.push('--prompt', c.vocab.join(', '));
        out = await run(c.whisper, args, 300e3);
      }
      return { text: dropHallucination(out.split('\n').map(l => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' '), c.vocab), end };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  sttQueue = job.catch(() => {});
  return job;
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
  const init = JSON.stringify({ dir, ...inboxSheets(dir, false), chats: listChats(path.resolve(dir)), memos: listMemos(path.resolve(dir)) }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>review-sheet</title><link rel="stylesheet" href="/sheet.css">
<body class="rs-page"><main><div class="eyebrow">REVIEW-SHEET · 받은편지함</div><h1>답변 시트</h1>
<p class="lede">${esc(dir)} · <span id="rs-upd"></span> <button type="button" class="rs-refresh" id="rs-refresh" title="목록 새로고침">↻ 새로고침</button> <a class="rs-boardlink" href="/board">진행판 →</a></p><div id="rs-list"></div></main>
<script>
const INIT = ${init};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when = iso => { if(!iso) return ''; const d = new Date(iso); return d.toLocaleString('ko-KR', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}); };
const tagKind = a => a.off ? 'off' : a.stage === '라이브' ? 'live' : a.stage === '배포대기' ? 'queue' : a.stage === '머지' ? 'main' : '';
const handled = s => !s.error && (s.submitted || !!s.checkedAt);
// 보고 시트 (hero 2026-10-15): 왼쪽 ✓ = 확인 체크(제목만 보고 바로) — 세션을 깨우지 않는다. 배지는 아이콘+한 단어
const check = s => s.report ? '<button type="button" class="rs-check' + (s.checkedAt ? ' on' : '') + '" data-d="' + esc(s.name) + '" aria-pressed="' + !!s.checkedAt + '" title="' + (s.checkedAt ? '확인 취소' : '확인') + '" aria-label="' + (s.checkedAt ? '확인 취소' : '확인') + '">✓</button>' : '';
const row = s => s.error
  ? '<li class="bad"><b>' + esc(s.name) + '</b> — ' + esc(s.error) + '</li>'
  : '<li class="' + (handled(s) ? 'done' : 'wait') + (s.report ? ' rep' : '') + (s.urgent ? ' urgent' : '') + '">' + check(s) + '<a href="/sheet.html?d=' + encodeURIComponent(s.name) + '">' +
    '<span class="rs-badge' + (s.assign ? ' rs-tag ' + tagKind(s.assign) : s.report ? ' rs-rep' : '') + '">' + (s.urgent ? '🔥 긴급 · ' : '') + (s.assign ? esc(s.assign.tag) : s.report ? esc(s.report) : s.submitted ? '✓ 제출됨' : '답 기다림') + '</span><b>' + esc(s.title) + '</b>' +
    '<small>' + (s.from ? esc(s.from) + ' · ' : '') + (s.report ? '' : s.picked + '/' + s.total + ' 답함 · ') +
    (s.checkedAt ? '확인 ' + when(s.checkedAt) : s.submitted ? '제출 ' + when(s.savedAt) : (s.createdAt ? '보냄 ' + when(s.createdAt) : '')) +
    (s.assign ? ' · <span class="rs-stage">' + esc(s.assign.issue) + (s.assign.note && s.assign.stage !== '배정' ? ' — ' + esc(s.assign.note) : '') + ' · ' + when(s.assign.stageAt) + '</span>' : '') + '</small></a>' +
    '<button type="button" class="rs-flag' + (s.urgent ? ' on' : '') + '" data-d="' + esc(s.name) + '" aria-pressed="' + !!s.urgent + '" title="' + (s.urgent ? '긴급 해제' : '긴급으로') + '" aria-label="' + (s.urgent ? '긴급 해제' : '긴급으로') + '">🔥</button></li>';
const chatRow = c => '<li class="chat' + (c.hub ? ' hub' : c.manager ? ' mgr' : ' sess') + (c.unreadHero ? ' new' : '') + '"><a href="/chat.html?c=' + encodeURIComponent(c.name) + '">' +
  '<span class="rs-badge">' + (c.unreadHero ? '새 답장 ' + c.unreadHero : c.hub ? '★ 메인 허브' : c.manager ? '🧭 매니저' : '💬 세션') + '</span><b>' + esc(c.title) + '</b>' +
  '<small>' + esc(c.owner) + (c.last ? ' · ' + esc(c.last.from === 'hero' ? '나' : c.last.from) + ': ' + esc(c.last.text.slice(0, 60)) + (c.last.text.length > 60 ? '…' : '') + ' · ' + when(c.last.ts) : ' · 아직 대화 없음') + '</small></a></li>';
const memoRow = m => '<li class="memo"><a href="/memo.html?m=' + encodeURIComponent(m.name) + '">' +
  '<span class="rs-badge">📝 메모</span><b>' + esc(m.name === 'hero' ? '나와의 메시지' : m.name) + '</b>' +
  '<small>' + (m.count ? m.count + '건 · 마지막 ' + when(m.lastAt) + ' · 누르면 복사' : '아직 없음 — 나한테 보내는 메시지, 세션은 읽지 않는다') + '</small></a></li>';
const render = d => {
  const open = d.sheets.filter(s => !handled(s)), done = d.sheets.filter(handled);
  const wait = open.filter(s => !s.report), reps = open.filter(s => s.report);
  const chats = d.chats || [], memos = d.memos || [];
  document.getElementById('rs-list').innerHTML =
    (memos.length ? '<ul class="rs-index rs-memos">' + memos.map(memoRow).join('') + '</ul>' : '') +
    (chats.length ? '<h2>상시 채널 <span class="rs-n rs-n-chat">' + chats.reduce((a, c) => a + c.unreadHero, 0) + '</span></h2><ul class="rs-index">' + chats.map(chatRow).join('') + '</ul>' : '') +
    '<h2>답 기다리는 중 <span class="rs-n">' + wait.length + '</span></h2><ul class="rs-index">' +
    (wait.map(row).join('') || '<li class="empty">기다리는 시트 없음</li>') + '</ul>' +
    (reps.length ? '<h2 class="rs-rep-h">확인할 보고 <span class="rs-n">' + reps.length + '</span></h2><ul class="rs-index">' + reps.map(row).join('') + '</ul>' : '') +
    '<h2 class="rs-done-h">제출됨 <span class="rs-n">' + (d.doneTotal ?? done.length) + '</span></h2><ul class="rs-index">' +
    (done.map(row).join('') || '<li class="empty">아직 없음</li>') + '</ul>' +
    (d.all === false ? '<button type="button" class="rs-refresh rs-more" id="rs-more">지난 시트 더 보기 (' + (d.doneTotal - done.length) + ')</button>' : '');
  document.getElementById('rs-upd').textContent = '갱신 ' + new Date().toLocaleTimeString('ko-KR');
  const n = wait.length + chats.reduce((a, c) => a + c.unreadHero, 0);
  document.title = (n ? '(' + n + ') ' : '') + 'review-sheet';
};
render(INIT);
let showAll = false;   // '지난 시트 더 보기' 누르면 그 뒤 새로고침도 전부
const refresh = async () => { const b = document.getElementById('rs-refresh'); b.disabled = true; try { const r = await fetch('/api/inbox' + (showAll ? '?all=1' : ''), {cache:'no-store'}); if(r.ok) render(await r.json()); } catch(_){ document.getElementById('rs-upd').textContent = '갱신 실패 — 서버 확인'; } b.disabled = false; };
document.getElementById('rs-refresh').addEventListener('click', refresh);
document.getElementById('rs-list').addEventListener('click', ev => { if (ev.target.id === 'rs-more') { ev.target.disabled = true; showAll = true; refresh(); } });
document.getElementById('rs-list').addEventListener('click', async ev => {   // ✓ = 보고 확인 체크 (알림 없음)
  const b = ev.target.closest('.rs-check'); if (!b) return;
  ev.preventDefault(); b.disabled = true;
  try {
    const r = await fetch('/__check?d=' + encodeURIComponent(b.dataset.d), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !b.classList.contains('on') }) });
    if (!r.ok) throw new Error(await r.text());
  } catch (e) { document.getElementById('rs-upd').textContent = '확인 체크 실패 — ' + e.message; }
  await refresh();
});
document.getElementById('rs-list').addEventListener('click', async ev => {   // 🔥 = 긴급 켜기/끄기 (담당 세션 채널에 알림)
  const b = ev.target.closest('.rs-flag'); if (!b) return;
  ev.preventDefault(); b.disabled = true;
  try {
    const r = await fetch('/__urgent?d=' + encodeURIComponent(b.dataset.d), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !b.classList.contains('on') }) });
    if (!r.ok) throw new Error(await r.text());
  } catch (e) { document.getElementById('rs-upd').textContent = '긴급 표시 실패 — ' + e.message; }
  await refresh();
});
setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if(!document.hidden) refresh(); });  // 폰: 탭 돌아오면 바로
</script></html>`;
}

export function startServer(dir, port = 0, host = '127.0.0.1') {
  const root = path.resolve(dir);
  fs.mkdirSync(path.join(root, 'answers'), { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__answers/file' && req.method === 'POST') {   // raw body → answers/<id>.files/<name>, ?n=<original name>
      const id = url.searchParams.get('sheet') || '';
      if (!ID_RE.test(id)) return send(res, 400, 'text/plain', 'sheet=<id> required ([a-z0-9-])');
      const chunks = []; let n = 0, big = false;
      req.on('data', c => { n += c.length; if (n > 50e6) { big = true; send(res, 413, 'text/plain; charset=utf-8', '50MB 넘음'); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (big) return;
        try { send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, name: saveSheetFile(root, id, req.headers['content-type'], url.searchParams.get('n'), Buffer.concat(chunks)) })); }
        catch (e) { send(res, 400, 'text/plain; charset=utf-8', String(e.message || e)); }
      });
      return;
    }
    {   // attachments: images/pdf/text show inline, anything else downloads (an attached .html must not run on this origin)
      const m = /^\/answers\/([a-z0-9][a-z0-9-]{0,63})\.files\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        if (!SHEET_FILE_RE.test(m[2])) return send(res, 404, 'text/plain', 'not found');
        return fs.readFile(sheetFilePath(root, m[1], m[2]), (err, buf) => {
          if (err) return send(res, 404, 'text/plain', 'not found');
          const ext = path.extname(m[2]).toLowerCase(), inline = /^\.(png|jpe?g|gif|webp|heic|pdf|txt|md)$/.test(ext);
          send(res, 200, inline ? (ext === '.pdf' ? 'application/pdf' : TYPES[ext]) : 'application/octet-stream', buf, inline ? {} : { 'content-disposition': 'attachment' });
        });
      }
    }
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
            for (const a of Object.values(json.answers || {})) if (a && typeof a === 'object') { const f = cleanFiles(root, id, a.files); if (f.length) a.files = f; else delete a.files; }
            json.savedAt = new Date().toISOString();
            const file = answersFile(root, id);
            const prevAsk = askOf(readAnswers(root, id));
            fs.writeFileSync(file + '.tmp', JSON.stringify(json, null, 2) + '\n');
            fs.renameSync(file + '.tmp', file);
            const notified = askOf(json) && askOf(json) !== prevAsk ? notifyAsk(root, id, askOf(json)) : null;
            send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, savedAt: json.savedAt, file, notified }));
          } catch (e) { send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + (e.message || e)); }
        });
        return;
      }
      return send(res, 405, 'text/plain', 'method');
    }
    if (url.pathname === '/api/stt') {
      if (req.method === 'GET') {
        const st = sttStatus();
        if (st.ready && url.searchParams.get('warm') === '1') sttServer().catch(() => {});   // 🎤 누르는 순간 모델을 미리 올린다
        return send(res, 200, TYPES['.json'], JSON.stringify(st));
      }
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method');
      // audio/* only: a cross-site page can't send that content-type without a preflight we never answer.
      const ctype = String(req.headers['content-type'] || '');
      if (!/^(audio|video)\//.test(ctype)) return send(res, 415, TYPES['.json'], JSON.stringify({ error: 'content-type audio/* 필요' }));
      const c = sttConfig(), st = sttStatus(c);
      if (!st.ready) return send(res, 503, TYPES['.json'], JSON.stringify({ error: 'STT 준비 안 됨: ' + st.missing.join(', ') }));
      const chunks = []; let size = 0, over = false;
      req.on('data', b => {
        if (over) return;
        size += b.length;
        if (size <= STT_MAX_BYTES) return chunks.push(b);
        over = true; chunks.length = 0;
        send(res, 413, TYPES['.json'], JSON.stringify({ error: '오디오가 너무 크다 (25MB)' }), { connection: 'close' });
      });
      req.on('end', async () => {
        if (over) return;
        if (!size) return send(res, 400, TYPES['.json'], JSON.stringify({ error: '빈 오디오' }));
        const t0 = Date.now();
        try {
          const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
          const { text, end } = await transcribe(Buffer.concat(chunks), c, { from, live: url.searchParams.get('live') === '1' });
          send(res, 200, TYPES['.json'], JSON.stringify({ text, end, ms: Date.now() - t0 }));
        } catch (e) { send(res, 500, TYPES['.json'], JSON.stringify({ error: String(e.message || e) })); }
      });
      return;
    }
    const cors = { 'access-control-allow-origin': '*' };
    if (url.pathname === '/api/sheets') return send(res, 200, TYPES['.json'], JSON.stringify({ dir: root, sheets: listSheets(root) }), cors);
    if (url.pathname === '/api/inbox') return send(res, 200, TYPES['.json'], JSON.stringify({ dir: root, ...inboxSheets(root, url.searchParams.get('all') === '1'), chats: listChats(root), memos: listMemos(root) }), cors);
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
    if (url.pathname === '/__check') {   // ?d=<보고 시트> GET → {checkedAt} · POST {on} — 페이지(hero) 전용, CORS 없음, 알림 없음
      const name = url.searchParams.get('d') || '';
      if (!ID_RE.test(name)) return send(res, 400, 'text/plain', 'd=<sheet> ([a-z0-9-])');
      if (req.method === 'GET') return send(res, 200, TYPES['.json'], JSON.stringify({ name, checkedAt: readChecked(root)[name] || null }));
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'GET|POST');
      if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return send(res, 415, 'text/plain', 'application/json');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        try { send(res, 200, TYPES['.json'], JSON.stringify(setChecked(root, name, !!JSON.parse(body || '{}').on))); }
        catch (e) { send(res, 400, 'text/plain; charset=utf-8', String(e.message || e)); }
      });
      return;
    }
    if (url.pathname === '/__urgent' && req.method === 'POST') {   // ?d=<시트> {on} — 페이지(hero) 전용, CORS 없음
      const name = url.searchParams.get('d') || '';
      if (!ID_RE.test(name)) return send(res, 400, 'text/plain', 'd=<sheet> ([a-z0-9-])');
      if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return send(res, 415, 'text/plain', 'application/json');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        try { send(res, 200, TYPES['.json'], JSON.stringify(setUrgent(root, name, !!JSON.parse(body || '{}').on))); }
        catch (e) { send(res, 400, 'text/plain; charset=utf-8', String(e.message || e)); }
      });
      return;
    }
    if (url.pathname === '/board') return serveFile(res, path.join(WEB, 'board.html'));
    if (url.pathname === '/api/board') return send(res, 200, TYPES['.json'], JSON.stringify({ board: readBoard(root) }), cors);
    if (url.pathname === '/hub') { const h = hubChat(root); return h ? send(res, 302, 'text/plain', '', { location: '/chat.html?c=' + encodeURIComponent(h.name) }) : send(res, 302, 'text/plain', '', { location: '/' }); }
    if (url.pathname === '/api/chats') return send(res, 200, TYPES['.json'], JSON.stringify({ chats: listChats(root) }), cors);
    if (url.pathname === '/api/chat') {
      const ch = url.searchParams.get('c') || '';
      if (!ID_RE.test(ch)) return send(res, 400, 'text/plain', 'c=<channel> required');
      const meta = readChatMeta(root, ch); if (!meta) return send(res, 404, 'text/plain', 'no such channel');
      // limit=N → 최근 N개만(hero 2026-10-11 "대화도 다 띄우지 마, 필요할 때 로드"). total 은 전체 개수, refs 는 잘린 범위 밖 답장 원문
      const all = readChatLog(root, ch), limit = Number(url.searchParams.get('limit')) || 0;
      if (!limit) return send(res, 200, TYPES['.json'], JSON.stringify({ meta, messages: all, total: all.length }), cors);
      const messages = all.slice(-limit), ids = new Set(messages.map(m => m.id)), refs = {};
      for (const m of messages) if (m.re && !ids.has(m.re)) { const q = all.find(x => x.id === m.re); if (q) refs[q.id] = q; }
      return send(res, 200, TYPES['.json'], JSON.stringify({ meta, messages, total: all.length, refs }), cors);
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
          const re = typeof j.re === 'string' && MSG_ID_RE.test(j.re) && readChatLog(root, ch).some(m => m.id === j.re) ? j.re : undefined;   // unknown original → plain message
          if (text || files.length) msg = appendChat(root, ch, 'hero', text, files, re);   // the page is always hero
          const meta = markSeen(root, ch, 'hero');
          send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, msg, meta }));
        } catch (e) { send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + (e.message || e)); }
      });
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '/index.html') return send(res, 200, TYPES['.html'], indexHtml(root));
    if (['/sheet.html', '/sheet.css', '/chat.html', '/memo.html', '/board.html', '/mic.js', '/compose.js'].includes(rel)) return serveFile(res, path.join(WEB, rel.slice(1)));
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
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
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
  if (cmd === 'assign' && rest.length === 4) dirArg = undefined;   // assign <id> <issue> <owner> → inbox
  if (cmd === 'stage' && rest[2] && STAGES[rest[2]]) dirArg = undefined;   // stage <id> <stage> [note] → inbox
  if (cmd === 'board' && rest.length === 2 && !(fs.existsSync(rest[1]) && fs.statSync(rest[1]).isDirectory())) dirArg = undefined;   // board <file|-> → inbox, board <dir> → 요약
  const dir = path.resolve(dirArg || INBOX);
  const isInbox = !dirArg;
  if (isInbox && cmd !== 'serve') fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });

  if (cmd === 'chat') {
    const [, sub, ch, ...words] = rest;
    const root = INBOX; fs.mkdirSync(chatDir(root), { recursive: true });
    const fmt = m => `#${m.id} ${m.ts.replace('T', ' ').slice(0, 16)}  ${m.from === 'hero' ? 'hero' : m.from}: ${m.re ? `↩#${m.re} ` : ''}${m.text}` +
      (m.files || []).map(f => `\n  [이미지] ${chatFilePath(root, ch, f)}`).join('');
    if (sub === 'hub') { if (!ch) { const h = hubChat(root); console.log(h ? h.name : '(허브 없음 — chat hub <ch>)'); return; } setHub(root, ch); console.log(`허브 = ${ch}  → http://127.0.0.1:${INBOX_PORT}/hub`); return; }
    if (sub === 'new') { const m = newChat(root, ch, flags.title, flags.owner, flags.hub || !listChats(root).length); console.log(`${chatLogFile(root, m.name)}\n  → http://127.0.0.1:${INBOX_PORT}/chat.html?c=${m.name}`); return; }
    if (sub === 'ls') { for (const c of listChats(root)) console.log(`${c.hub ? '★' : ''}${c.name}\t${c.owner}\t${c.count}건\thero 미읽 ${c.unreadHero}\t세션 미읽 ${c.unreadOwner}\t${c.title}`); return; }
    if (!ch || !readChatMeta(root, ch)) { console.error(`채널 ${ch || '?'} 없음 — chat new <ch>`); process.exit(1); }
    if (sub === 'say') {
      const text = words[0] === '-' || !words.length ? fs.readFileSync(0, 'utf8').trim() : words.join(' ');
      if (!text) { console.error('text 없음'); process.exit(2); }
      const why = flags.notice ? null : chatGate(text);
      if (why) { console.error(`보내지 않음 — ${why}. hero 가 보고 맞는지 정할 것(결과물·링크·질문)은 시트로: review-sheet new <이름>\n받음·담당·머지/배포 한 줄처럼 꼭 채팅이어야 하는 알림이면 --notice 를 붙여 다시 보낸다.`); process.exit(6); }
      const meta = readChatMeta(root, ch); const m = appendChat(root, ch, meta.owner, text, undefined, flags.re); markSeen(root, ch, 'owner');
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
    fs.writeFileSync(plist, launchdPlist(port, flags.lan === true));   // 기본 127.0.0.1 — 폰은 tailscale serve(HTTPS)로
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
    const from = fromId();
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
    const since = fs.existsSync(path.join(assignDir(dir), '.since')) ? assignSince(dir) : '9';   // 게이트 안 쓰는 폴더는 표시 안 함
    const tag = (s, st) => st === 'none' ? '\t배정없음' : st === 'changed' ? '\t답바뀜' : s.assign ? `\t${s.assign.stage}${st === 'stalled' ? '(멈춤)' : ''} ${s.assign.issue}` : '';
    for (const s of listSheets(dir)) console.log(s.error ? `${s.name}\tERROR ${s.error}` : `${s.urgent ? '🔥' : ''}${s.name}\t${s.id}\t${s.submitted ? '제출됨' : '대기'}\t${s.picked}/${s.total}\t${s.savedAt || '-'}\t${s.title}${tag(s, assignState(dir, s, since))}`);
    return;
  }
  if (cmd === 'assign') {
    const [id, issue, owner] = rest.slice(isInbox ? 1 : 2);
    if (!id || !issue || !owner) usage();
    const s = listSheets(dir).find(x => !x.error && (x.name === id || x.id === id));
    if (!s) { console.error(`${dir} 에 ${id} 시트 없음`); process.exit(1); }
    if (!s.submitted) { console.error(`${s.name}: 아직 제출 안 됨 — 답이 온 뒤에 배정한다`); process.exit(1); }
    const a = writeAssign(dir, s.id, issue, owner);
    console.log(`${s.name}\t배정 ${a.issue} → ${a.owner}`);
    return;
  }
  if (cmd === 'stage') {
    const [id, stage, ...words] = rest.slice(isInbox ? 1 : 2);
    if (!id || !stage) usage();
    const s = listSheets(dir).find(x => !x.error && (x.name === id || x.id === id));
    if (!s) { console.error(`${dir} 에 ${id} 시트 없음`); process.exit(1); }
    try { const a = writeStage(dir, s.id, stage, words.join(' '), undefined, { off: flags.off, eta: flags.eta }); console.log(`${s.name}\t${stageTag(a.stages.at(-1))}${words.length ? ' — ' + words.join(' ') : ''}`); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  if (cmd === 'board') {
    const src = rest.at(-1);
    if (rest.length < 2 || (dirArg && rest.length === 2)) { const b = readBoard(dir); if (!b) { console.error('진행판 없음'); process.exit(1); } for (const st of BOARD_STATUS) console.log(`${st}\t${b.cards.filter(c => c.status === st).length}`); console.log(`updatedAt\t${b.updatedAt}`); return; }
    let j; try { j = JSON.parse(src === '-' ? await (async () => { let t = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) t += c; return t; })() : fs.readFileSync(src, 'utf8')); } catch (e) { console.error('board: JSON 읽기 실패 — ' + e.message); process.exit(1); }
    try { const b = writeBoard(dir, j); console.log(`${boardFile(dir)}\t카드 ${b.cards.length}\t→ http://127.0.0.1:${INBOX_PORT}/board`); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  if (cmd === 'checks') {   // 보고 시트 확인 현황 — hero 가 ✓ 한 것(기본) / --open 아직 안 한 것. 세션이 나중에 한 번에 본다
    for (const s of listSheets(dir)) {
      if (s.error || !s.report || (flags.prefix && !String(s.name).startsWith(flags.prefix))) continue;
      if (flags.open ? s.checkedAt || s.submitted : !s.checkedAt) continue;
      if (flags.since && String(s.checkedAt) < String(flags.since)) continue;
      console.log(`${s.name}\t${s.checkedAt || '확인 안 함'}\t${s.report} ${s.title}`);
    }
    return;
  }
  if (cmd === 'unassigned') {
    const since = assignSince(dir), open = [];
    for (const s of listSheets(dir)) {
      if (flags.prefix && !String(s.name).startsWith(flags.prefix)) continue;
      const st = assignState(dir, s, since, flags.hours || 24);
      if (st === 'none' || st === 'changed') open.push(`${s.name}\t${st === 'none' ? '배정없음' : '답바뀜'}\t${s.savedAt}\t${s.from || '-'}\t${s.title}`);
      if (st === 'stalled') open.push(`${s.name}\t멈춤\t${s.assign.stageAt}\t${s.assign.owner}\t${s.title} (${s.assign.stage} ${s.assign.issue})`);
    }
    for (const l of open) console.log(l);
    if (open.length) process.exitCode = 5;
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
    else console.log(renderMarkdown(sheet, saved, dir));
    if (cmd === 'read' && !saved) process.exitCode = 4;
    return;
  }
  usage();
}

const entry = process.argv[1] && fs.realpathSync(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message || e); process.exit(1); });
