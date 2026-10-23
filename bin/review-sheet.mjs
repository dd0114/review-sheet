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
 *   review-sheet items <dir> <id> [<q> done|defer|reject|moved …]  per-question ledger — every answered question must point somewhere before the sheet closes
 *   review-sheet record <dir> <id> [--issue N]       post the full read output as an issue comment; later calls post only the changed lines
 *   review-sheet unassigned <dir> [--prefix P]       submitted sheets with unattached questions / reverted PR / closed issue but stage short (exit 5 if any)
 *
 * <dir> may be omitted everywhere: it then defaults to the INBOX (~/.review-sheet/inbox, or $REVIEW_SHEET_INBOX),
 * one folder every session drops its sheets into, served once (port 5600) like a queue — pending sheets on top,
 * submitted ones marked and listed below. `review-sheet install-inbox` registers that server with launchd (macOS).
 *
 * Layout of <dir> (the sheet dir, usually `review/` inside the repo):
 *   <name>-data.js      one sheet: `window.SHEET = { id, title, sections:[{ code, questions:[…] }] }`
 *   answers/<id>.json   what the reviewer saved: { sheet, answers:{ "<code>-<k>": { pick, memo, files:[{name,orig}] } }, savedAt }
 *   answers/<id>.files/ files the reviewer attached to a question (page: 📎·paste·drop → POST /__answers/file), served at /answers/<id>.files/<name>
 *   assign/<id>.json    { issue, owner, repo, at, stages:[{stage,note,at,by,pr,sha,…}], items:{<q>:{kind,pr|issue|to,ans,at,by}}, heroSeenAt } written by `assign`/`stage`/`items`;
 *                       assign/.since = when the gate started (older answers are exempt), assign/.items-since = when the per-question ledger started
 *   record/<id>.json    { "<repo>#N": { hashes, at, url } } lines already posted by `record`
 *   anything else       images etc. the sheet references by relative path
 *
 * 음성 입력: POST /api/stt[?live=1&from=초] (audio/* 바디) → ffmpeg → whisper.cpp(whisper-cli) 로 **로컬에서만** 전사해 { text, end } 를 돌려준다(live = 말하는 중 미리보기).
 *   모델 ~/.review-sheet/models/ggml-large-v3-turbo.bin · 단어장 ~/.review-sheet/vocab.txt(한 줄 1단어 → --prompt).
 *   env 로 교체: REVIEW_SHEET_WHISPER_BIN / _WHISPER_MODEL / _FFMPEG / _VOCAB / _STT_LANG(기본 ko). 오디오는 클라우드로 나가지 않는다 —
 *   REVIEW_SHEET_STT_REMOTE 를 주면 tailnet 안 내 다른 맥(whisper-server 와 같은 /inference)에 먼저 보내고, 안 되면 이 맥이 적는다.
 *
 * No dependencies. Node 18+.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import process from 'node:process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { vapidKeys, readSubs, addSub, removeSub, pushAll } from './push.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'web');
const TEMPLATE = path.resolve(HERE, '..', 'templates', 'example-data.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
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
  review-sheet wait-any <ch> [--sheets <prefix>[,<prefix>…]] [--timeout SEC] [--settle SEC]
  review-sheet ls    [dir]
  review-sheet assign [dir] <id> <issue#> <도메인:창> [--repo o/r]   # 제출된 시트의 후속 일 담당 기록 (이슈인지 gh 로 확인, PR·뒤바뀐 순서 거부)
  review-sheet stage [dir] <id> <머지|배포대기|라이브|끝> [--pr N] [--sha S] [--off [이유]] [--eta <언제>] [메모…]   # 단계 보고 — 머지 = --pr(MERGED), 라이브 = --sha(머지 커밋 포함) 또는 --off <이유>
  review-sheet items [dir] <id> [<문항> done --pr N | done --rule "<근거>" | defer --issue N | reject [이유] | moved <시트>]   # 문항 장부 — 답한 문항마다 붙어야 시트가 닫힘. 문항 없이 = 현황
  review-sheet record [dir] <id> [--issue N] [--repo o/r]   # read 출력 전체(메모·_ask·문항 질문)를 이슈 댓글로, 다시 부르면 바뀐 줄만
  review-sheet migrate-assign [dir] [--dry-run]   # 옛 뒤바뀐 assign(이슈 칸에 창, 담당 칸에 번호) 맞바꾸기 — assign/.backup-<시각>/ 에 백업
  review-sheet asks [dir] [<시트>] [--open] [--prefix P]   # 문항 질문(시트 안 '＋ 이것만 묻기')과 답 수 — --open 답 없는 것만
  review-sheet ask-reply [dir] <시트> <문항> "답" [--notice]   # 그 문항 질문에 ↩ 답장 → 시트 그 문항 밑에 바로 뜬다(asks/<시트>.jsonl)
  review-sheet checks [dir] [--open] [--since ISO] [--prefix P]   # 보고 시트(report:) — hero 가 ✓ 확인한 것 / --open 아직 안 한 것. 체크는 세션을 깨우지 않는다
  review-sheet unassigned [dir] [--prefix P]  # 문항 안 붙음(배정없음 포함)·되돌림·이슈 닫혔는데 단계 덜 됨 — 있으면 exit 5
  review-sheet dash  [dir] [<file|->]   # 자원판(보기 전용) — dash.json {cards:[{label,value,unit,sub,level,series}],bars:[{label,total,unit,parts:[{label,value,kind}]}],groups:[{title,rows:[{label,sub,cols,series}]}],series:{k:{start,step,values}}} 쓰기
  review-sheet batch [dir] [<file|->] [--domain D]   # 배치판(보기 전용, /batch) — pkch-batch-view/1 {rules:[{job,…,runs:[{id,status,verdict,line,startedAt,…,log,taken}]}]} 를 도메인별로 더함(실행 id 로 합침, 규칙마다 최근 ${BATCH_KEEP}개), 인자 없으면 요약
  review-sheet links [dir] [<file|->]   # 받은편지함 위 줄 외부 링크 — {links:[{label,url}]} url=http(s) 또는 /경로, 같은 label 덮어씀, url 비우면 지움, 8개까지 (#47)
  review-sheet board [dir] [<file|->]   # 진행판(보기 전용) — board.json {cards:[{title,status:todo|doing|done,priority,owner,mode:claude|system|idle,modeNote,url}]} 쓰기, 인자 없으면 요약
  review-sheet tab [dir] [--prefix X] [--icon Y] [--clear]   # 탭 이름표 — <inbox>/tab.json {prefix,icon}: 모든 탭 제목 앞 'X · ' + 이모지 탭 아이콘. 서버 재시작 없이 반영, env REVIEW_SHEET_TAB_PREFIX/ICON 이 이김. 빈 값 = 그 칸 지움
  review-sheet install-inbox [--port N]      # launchd: serve the inbox on boot (macOS)
  review-sheet chat new  <ch> [--title T] [--owner <session>] [--hub]   # 상시 채널 (inbox/chat/<ch>.jsonl) — hero ↔ 세션 메신저. 첫 채널 = 자동 허브
  review-sheet chat hub  [<ch>]                                  # 메인 허브 채널 보기/지정 — 받은편지함 맨 위 고정, /hub 가 그 채널로
  review-sheet chat pin <ch> <text|->  /  chat unpin <ch>       # 방 맨 위 고정 글 하나 (meta.pin) — 링크 그대로 둬도 됨, 새로 걸면 바뀜
  review-sheet chat ls | read <ch> [--all] [--json] | say <ch> [--re <id>] [--notice] <text…|-> | wait <ch> [--timeout SEC]   # --re = 그 메시지에 답장(카톡식 인용)
  review-sheet wait-any <ch> [--sheets <prefix>[,<prefix>…]] [--timeout SEC] [--settle SEC]   # hero 글과 새 시트 제출을 한 번에 기다림
  (메모: http://127.0.0.1:${INBOX_PORT}/memo.html — hero 가 자기한테 보내는 메시지, CLI 없음·세션은 읽지 않는다)
  [dir] omitted → inbox ${INBOX} (one folder for every session; served on :${INBOX_PORT})`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan' || a === '--json' || a === '--all' || a === '--hub' || a === '--notice' || a === '--open' || a === '--dry-run' || a === '--clear') flags[a.slice(2)] = true;
    else if (a === '--off') { flags.off = true; if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.offReason = argv[++i]; }   // --off [이유] — 라이브 근거로도 쓴다(#40)
    else if (a === '--port' || a === '--timeout' || a === '--hours' || a === '--settle') flags[a.slice(2)] = Number(argv[++i]);
    else if (a === '--title' || a === '--owner' || a === '--re' || a === '--prefix' || a === '--sheets' || a === '--eta' || a === '--since' || a === '--domain' || a === '--pr' || a === '--sha' || a === '--issue' || a === '--repo' || a === '--rule' || a === '--icon') flags[a.slice(2)] = String(argv[++i] || '');
    else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); usage(); }
    else rest.push(a);
  }
  return { flags, rest };
}

/** Chat is for short notices; anything hero must look at or confirm belongs on a sheet (hero 2026-10-14).
 *  Returns why a chat message looks like review material, or null. `chat say --notice` skips it.
 *  heroReply = hero 메시지에 다는 답장(--re): 물은 걸 다 답하라고 2000자까지(hero 2026-10-15, 시트 root-terse-answers-1015 —
 *  500자에 막혀 답을 깎아 보내 "왜 대충 답하냐"가 나왔다). 링크·확인 요청 막기는 그대로 — 단 '보고:' 로 시작하면 링크 통과. */
export const CHAT_MAX = 500, CHAT_REPLY_MAX = 2000;
export function chatGate(text, { heroReply = false } = {}) {
  // '보고:' 로 시작하는 끝·머지·배포 보고는 확인할 URL 이 필수라 링크를 허용한다(hero 2026-10-21). 확인 요청·길이 막기는 그대로
  if (!/^\s*보고\s*:/.test(text) && /https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}:\d+/.test(text)) return '링크가 들어 있음';
  if (/말씀\s*(해\s*)?주세요|알려\s*주세요|확인\s*(해\s*)?주세요|봐\s*주세요|골라\s*주세요|정해\s*주세요|컨펌|괜찮은지|괜찮을까요|어떠세요|어떤가요|할까요\?|될까요\?|맞나요\?/.test(text)) return '확인·결정 요청이 들어 있음';
  const max = heroReply ? CHAT_REPLY_MAX : CHAT_MAX;
  if (text.length > max) return heroReply ? `긴 글(${text.length}자 > ${max}) — 답을 줄이지 말고 메시지 두 개로 나눠 보내거나 시트로` : `긴 글(${text.length}자 — 결과 보고는 시트로. hero 질문에 답하는 거면 --re <그 메시지 id> 로 답장하면 ${CHAT_REPLY_MAX}자까지)`;
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

/* gh 근거 확인 (hero 2026-10-18 "리뷰시트로 승인한 변경사항들이 반영안되고 누락") — 단계·문항·배정이 말로만 찍히지 않게 GitHub 에 물어 본다.
   전부 `gh api` 하나로(REVIEW_SHEET_GH 로 바꿀 수 있다 — 시험은 스텁). repo 를 안 주면 gh 가 지금 폴더 레포로 {owner}/{repo} 를 채운다. */
export function ghApi(p, { input, jq } = {}) {
  const args = ['api', p]; if (input !== undefined) args.push('--input', '-'); if (jq) args.push('--jq', jq);   // jq = 필요한 필드만 받아 큰 응답(compare 의 files 등) 피함
  let out;
  try { out = execFileSync(process.env.REVIEW_SHEET_GH || 'gh', args, { encoding: 'utf8', input: input === undefined ? '' : JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { throw new Error(`gh api ${p} 실패 — ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
  return out.trim() ? JSON.parse(out) : null;
}
const repoPath = repo => repo ? `repos/${repo}` : 'repos/{owner}/{repo}';
/** '#12' · '12' · 'owner/name#12' · github.com/…/pull|issues/12 → { repo, n }; 숫자가 아니면 null */
export function parseRef(s, repo = '') {
  const m = String(s || '').trim().match(/^(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/|([\w.-]+\/[\w.-]+)#|#)?(\d+)$/);
  return m ? { repo: m[1] || m[2] || repo || '', n: Number(m[3]) } : null;
}
export const refStr = r => `${r.repo || ''}#${r.n}`;
const repoOfUrl = u => (String(u || '').match(/github\.com\/([\w.-]+\/[\w.-]+)\//) || [])[1] || '';
export function ghPull(ref) {
  const p = ghApi(`${repoPath(ref.repo)}/pulls/${ref.n}`) || {};
  return { n: ref.n, repo: (p.base && p.base.repo && p.base.repo.full_name) || repoOfUrl(p.html_url) || ref.repo, merged: !!p.merged,
    state: p.state || '', title: p.title || '', url: p.html_url || '', mergeCommit: p.merge_commit_sha || '', mergedAt: p.merged_at || '' };
}
export function ghIssue(ref) {
  const i = ghApi(`${repoPath(ref.repo)}/issues/${ref.n}`) || {};
  return { n: ref.n, repo: repoOfUrl(i.html_url) || ref.repo, isPR: !!i.pull_request, state: i.state || '', url: i.html_url || '' };
}
/** 운영 커밋 sha 가 commit 을 품는가 — compare commit...sha 가 identical·ahead 면 품는다 */
export function ghContains(repo, commit, sha) {
  const c = ghApi(`${repoPath(repo)}/compare/${commit}...${sha}`, { jq: '{status: .status}' }) || {};   // 오래된 커밋 compare 는 수 MB — status 만
  return c.status === 'identical' || c.status === 'ahead';
}
/** pr 을 되돌린 머지된 PR — GitHub Revert 버튼 본문 "Reverts o/r#N" 또는 제목 'Revert "<원제목>"' */
export function ghRevertOf(pr) {
  if (!pr.repo) return null;
  const q = `repo:${pr.repo} is:pr is:merged revert` + (pr.mergedAt ? ` merged:>=${pr.mergedAt.slice(0, 10)}` : '');
  const r = ghApi(`search/issues?q=${encodeURIComponent(q)}&per_page=50`) || {};
  const body = new RegExp(`Reverts (?:${pr.repo.replace(/[.]/g, '\\.')})?#${pr.n}\\b`);
  const hit = (r.items || []).find(x => x.number !== pr.n && (body.test(x.body || '') || (pr.title && x.title === `Revert "${pr.title}"`)));
  return hit ? { repo: pr.repo, n: hit.number, title: hit.title } : null;
}

/* 배정 검사 (#40) — 이슈는 숫자(gh 로 이슈인지 확인, PR 거부), 담당은 <도메인>:<창>. 88장 중 76장이 둘을 뒤바꿔 적었다. */
export const OWNER_RE = /^[a-z0-9][\w-]*:[^\s:#]+$/i;
export function checkAssign(issue, owner, { repo = '', verify = true } = {}) {
  const ref = parseRef(issue, repo);
  if (!ref && parseRef(owner) && OWNER_RE.test(String(issue))) throw new Error(`순서가 뒤바뀜 — assign <시트> <이슈#> <도메인:창> (받은 값: ${issue} ${owner})`);
  if (!ref) throw new Error(`이슈는 숫자(#12 · 12 · owner/repo#12) — 받은 값: ${issue}`);
  if (!OWNER_RE.test(String(owner))) throw new Error(`담당은 <도메인>:<창> (예: proj:ws1) — 받은 값: ${owner}`);
  if (!verify) return { ref };
  const i = ghIssue(ref);
  if (i.isPR) throw new Error(`${refStr(ref)} 는 PR — 후속 일을 적을 이슈 번호를 준다(PR 은 stage --pr / items done --pr)`);
  return { ref: { repo: i.repo || ref.repo, n: ref.n }, url: i.url, state: i.state };
}
export function writeAssign(dir, id, issue, owner, by = fromId(), opt = {}) {
  const chk = opt.check === false ? null : checkAssign(issue, owner, opt);
  assignSince(dir);
  const old = readAssign(dir, id) || {}, at = new Date().toISOString();
  const show = chk ? `#${chk.ref.n}` : String(issue);
  const rec = { ...old, issue: show, owner: String(owner), at,
    stages: [...(old.stages || []), { stage: '배정', note: `${show} → ${owner}`, at, by }] };
  if (chk && chk.ref.repo) rec.repo = chk.ref.repo; if (chk && chk.url) rec.issueUrl = chk.url;
  saveAssign(dir, id, rec);
  return rec;
}
/** 옛 뒤바뀐 배정 고치기 — owner 칸이 이슈 번호이고 issue 칸이 번호가 아니면 맞바꾼다. 고치기 전 assign/.backup-<시각>/ 에 복사 */
export function migrateAssign(dir, { dryRun = false } = {}) {
  let names = []; try { names = fs.readdirSync(assignDir(dir)).filter(f => f.endsWith('.json')); } catch { return { fixed: [], total: 0 }; }
  const fixed = [];
  for (const f of names) {
    const a = readAssign(dir, f.slice(0, -5)); if (!a) continue;
    if (parseRef(a.issue) || !parseRef(a.owner)) continue;
    fixed.push({ id: f.slice(0, -5), issue: `#${parseRef(a.owner).n}`, owner: String(a.issue), was: [a.issue, a.owner] });
  }
  if (dryRun || !fixed.length) return { fixed, total: names.length };
  const bak = path.join(assignDir(dir), '.backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(bak, { recursive: true });
  for (const x of fixed) {
    fs.copyFileSync(path.join(assignDir(dir), x.id + '.json'), path.join(bak, x.id + '.json'));
    const a = readAssign(dir, x.id); a.issue = x.issue; a.owner = x.owner;
    const r = parseRef(x.was[1]); if (r && r.repo && !a.repo) a.repo = r.repo;
    a.stages = (a.stages || []).map(s => s.stage === '배정' && s.note === `${x.was[0]} → ${x.was[1]}` ? { ...s, note: `${x.issue} → ${x.owner}` } : s);
    a.migrated = { at: new Date().toISOString(), was: x.was };
    saveAssign(dir, x.id, a);
  }
  return { fixed, total: names.length, backup: bak };
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
  const pr = x.pr ? ' ' + String(x.pr).replace(/^.*#/, '#') : '', sha = x.sha ? ' ' + String(x.sha).slice(0, 7) : '';   // 근거가 칩에 붙는다(#40)
  switch (x.stage) {
    case '머지': return '🔀 머지됨' + pr + off + eta;
    case '배포대기': return '⏳ 배포 대기' + off + eta;
    case '라이브': return '🚀 배포됨' + sha + (x.off ? off + eta : '');
    case '끝': return '✅ 끝';
    case '되돌림': return '↩ 되돌림' + pr;
    default: return x.stage;
  }
}
/* 보고 시트 (hero 2026-10-15) — 결정할 게 없는 알림(머지·배포·끝). 시트 데이터에 report: 'merged'|'deployed'|'done'
   (또는 '머지'·'배포'·'끝'). 받은편지함 줄·시트 맨 위에 아이콘+한 단어 배지, 제출 대신 ✓ 확인 체크.
   체크는 answers 가 아니라 inbox/checked.json 에만 남는다 → wait 가 안 깨고 세션 토큰을 안 쓴다. 세션은 나중에 `checks` 로 한 번에 본다.
   report 가 없는 옛 시트도 제목이 '✅ 머지했습니다 — …' 처럼 시작하면 보고로 보고, 그 긴 머리는 배지로 옮긴다.
   📌 note('보고'·'이렇게 해놓겠습니다' 제목)는 더 이상 보고가 아니다(hero 2026-10-22) — 읽고 확인할 시트(스터디 요약·계획)가 보고 칸으로
   내려가 Peter 가 놓쳤다. 이제 일반 리뷰 시트. 단 이미 ✓ 확인된(checked.json 에 있는) 옛 시트는 예전 분류 그대로(목록 폭주 방지). */
export const REPORTS = { merged: '🔀 머지됨', deployed: '🚀 배포됨', done: '✅ 끝남', note: '📌 보고' };   // note = 옛 ✓ 시트 표시용
const REPORT_ALIAS = { 머지: 'merged', 배포: 'deployed', 끝: 'done', 보고: 'note' };
const REPORT_TITLE = [
  [/^\s*(?:(?:✅|🔀|📌)\s*)?머지(?:했습니다|되었습니다|됨|완료)\s*[—:·-]?\s*/, 'merged'],
  [/^\s*(?:(?:✅|🚀|📌)\s*)?배포(?:했습니다|되었습니다|됨|완료)\s*[—:·-]?\s*/, 'deployed'],
  [/^\s*(?:📌\s*)?(?:이렇게\s*)?해\s*놓겠습니다\s*[—:·-]?\s*/, 'note'],
];
/* '이렇게 해놓겠습니다' 계획 시트 = report 없는 리뷰 시트(hero 2026-10-22). 첫 선택지가 '이대로 진행'·'머지' 여도 리뷰 칸에 남는다
   — 제목에서 보고를 자동으로 잡지 않는다. */
const PLAN_RE = /해\s*놓겠습니다/;
const GO_OPT = /확인|그대로|진행|머지|이대로|실행|적용/;   // 옛 ✓ 계획 시트(legacyReportOf) 전용
const kindOf = r => r ? (REPORTS[r] ? r : REPORT_ALIAS[r] || 'note') : '';
/** 결정할 게 있는 시트: 첫 선택지가 '확인'·'그대로' 류가 아닌 질문이 있거나, lede·제목에 승인 요청. */
const decides = (sheet, ok = /확인|그대로/) => (ok !== GO_OPT && /승인 요청/.test(String(sheet.title || '') + String(sheet.lede || ''))) ||
  (sheet.sections || []).some(s => (s.questions || []).some(q => { const o = Array.isArray(q) ? q[2] : q.opts; const f = o && o[0]; const l = Array.isArray(f) ? f[0] : f; return l && !ok.test(String(l)); }));
/** 2026-10-22 전 규칙(note·해놓겠습니다 = 보고). 이미 ✓ 확인된 시트만 이걸로 본다. */
function legacyReportOf(sheet) {
  const t = String(sheet.title || sheet.id || '');
  let kind = kindOf(sheet.report), title = t;
  const plan = PLAN_RE.test(t + String(sheet.lede || ''));
  if (decides(sheet, plan ? GO_OPT : undefined)) return null;
  for (const [re, k] of REPORT_TITLE) if (re.test(t)) { title = t.replace(re, '') || t; kind = kind || k; break; }
  if (!kind && plan) kind = 'note';
  return kind ? { kind, label: REPORTS[kind], title } : null;
}
/** 보고 시트면 { kind, label, title }, 아니면 null. opt.checked = 그 시트가 checked.json 에 있음(옛 note ✓ 시트를 보고로 남김). */
export function reportOf(sheet, { checked = false } = {}) {
  if (checked) { const old = legacyReportOf(sheet); if (old) return old; }
  const t = String(sheet.title || sheet.id || '');
  let kind = kindOf(sheet.report), title = t;
  // 고를 질문(승인·A/B)이 있으면 결정 시트 — report 를 직접 넣었어도(hero 2026-10-21 infra-dorm-iam-narrow-1020)
  if (kind === 'note' || decides(sheet)) return null;
  const plan = PLAN_RE.test(t + String(sheet.lede || ''));
  for (const [re, k] of REPORT_TITLE) if (re.test(t)) { if (k === 'note' || (!kind && plan)) break; title = t.replace(re, '') || t; kind = kind || k; break; }
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
/* 단계 근거 (#40) — '머지' 105개 중 73개가 메모 빈칸, 같은 '머지'를 창 3개가 40초 안에 찍었다. 이제 근거 없이는 안 찍힌다:
   머지 = --pr N (gh 로 MERGED 확인, 머지 커밋 기록) · 라이브 = --sha <운영 커밋> 이 그 머지 커밋을 품음(gh compare) 또는 --off <이유>.
   같은 단계는 한 번만 — 되돌림(근거 PR 이 revert 됨) 뒤에는 새로 찍을 수 있다. by = REVIEW_SHEET_FROM(세션 이름). */
const epoch = a => { const st = (a && a.stages) || [], i = st.map(x => x.stage).lastIndexOf('되돌림'); return st.slice(i + 1); };
export function writeStage(dir, id, stage, note = '', by = fromId(), opt = {}) {
  const st = STAGES[stage];
  if (!st) throw new Error(`단계는 ${[...new Set(Object.values(STAGES))].join(' · ')} 중 하나 (받은 값: ${stage})`);
  const a = readAssign(dir, id);
  if (!a) throw new Error(`${id}: 아직 배정 안 됨 — 먼저 assign <시트> <이슈#> <담당>`);
  const dup = epoch(a).find(x => x.stage === st);
  if (dup) throw new Error(`${id}: '${st}' 는 이미 찍힘 (${dup.at} · ${dup.by || '?'}${dup.pr ? ' · ' + dup.pr : ''}) — 같은 단계는 한 번만`);
  const rec = { stage: st, note: String(note), at: new Date().toISOString(), by };
  const repo = opt.repo || a.repo || '';
  if (st === '머지') {
    const ref = parseRef(opt.pr, repo);
    if (!ref) throw new Error(`${id}: 머지 는 근거 필요 — --pr <번호> (머지된 PR)`);
    const p = ghPull(ref);
    if (!p.merged) throw new Error(`${id}: PR ${refStr(ref)} 는 머지 안 됨 (${p.state || '?'}) — 머지된 뒤에 찍는다`);
    Object.assign(rec, { pr: refStr({ repo: p.repo, n: p.n }), url: p.url, mergeCommit: p.mergeCommit, mergedAt: p.mergedAt, title: p.title });
  }
  if (st === '라이브') {
    if (opt.sha) {
      let m = epoch(a).find(x => x.stage === '머지' && x.mergeCommit);
      if (opt.pr) { const pr = parseRef(opt.pr, repo); if (!pr) throw new Error(`--pr 는 번호 (받은 값: ${opt.pr})`); const p = ghPull(pr); if (!p.merged) throw new Error(`${id}: PR ${opt.pr} 는 머지 안 됨`); m = { pr: refStr({ repo: p.repo, n: p.n }), mergeCommit: p.mergeCommit }; }
      if (!m) throw new Error(`${id}: 어떤 머지가 나갔는지 모름 — 먼저 stage 머지 --pr N, 또는 라이브 에 --pr N 도 같이`);
      const r = parseRef(m.pr) || {};
      if (!ghContains(r.repo || repo, m.mergeCommit, opt.sha)) throw new Error(`${id}: 운영 커밋 ${opt.sha} 에 머지 커밋 ${m.mergeCommit.slice(0, 7)} (${m.pr}) 이 없다 — 아직 안 나갔다`);
      Object.assign(rec, { sha: String(opt.sha), pr: m.pr, mergeCommit: m.mergeCommit });
    } else if (!opt.offReason) throw new Error(`${id}: 라이브 는 근거 필요 — --sha <운영 커밋> (머지 커밋을 품어야 함) 또는 --off <이유>`);
  }
  if (opt.off || opt.offReason) rec.off = true;
  if (opt.offReason) rec.offReason = String(opt.offReason).slice(0, 200);
  if (opt.eta) rec.eta = String(opt.eta).slice(0, 60);
  a.stages = [...(a.stages || [{ stage: '배정', note: `${a.issue} → ${a.owner}`, at: a.at }]), rec];
  saveAssign(dir, id, a);
  return a;
}

/* 문항 장부 (#40) — 답한 문항(고름·메모·첨부·섹션 메모·추가 질문 _ask)마다 어디로 갔는지 하나씩 붙어야 시트가 닫힌다.
   done --pr N(머지된 PR) · done --rule <근거>(코드 PR 없이 규칙·운영으로 적용, #49) · defer --issue N(이슈, PR 아님) · reject [이유] · moved <시트>. 붙인 뒤 hero 가 그 문항 답을 바꾸면(해시) 다시 열린다. */
export const ITEM_KINDS = ['done', 'defer', 'reject', 'moved'];
const hasAns = a => !!a && !!(a.pick || (typeof a.memo === 'string' && a.memo.trim()) || (a.files || []).length);
export const answeredKeys = saved => Object.keys((saved && saved.answers) || {}).filter(k => hasAns(saved.answers[k]));
const ansHash = a => crypto.createHash('sha1').update(JSON.stringify([a && a.pick || '', a && a.memo || '', ((a && a.files) || []).map(f => f.name)])).digest('hex').slice(0, 12);
const revertedPrs = a => new Set(((a && a.stages) || []).filter(x => x.stage === '되돌림' && x.reverts).map(x => x.reverts));
/** 답한 문항 중 안 붙은 것 — missing(장부 없음) · changed(붙인 뒤 답 바뀜) · reverted(done 의 PR 이 되돌려짐) */
export function itemsOpen(dir, id, a = readAssign(dir, id), saved = readAnswers(dir, id)) {
  const it = (a && a.items) || {}, rv = revertedPrs(a), A = (saved && saved.answers) || {};
  const keys = answeredKeys(saved), out = [];
  for (const k of keys) {
    const x = it[k];
    if (!x) out.push({ k, why: 'missing' });
    else if (x.ans !== ansHash(A[k])) out.push({ k, why: 'changed' });
    else if (x.kind === 'done' && rv.has(x.pr)) out.push({ k, why: 'reverted' });
  }
  return { keys, open: out };
}
export function writeItem(dir, id, key, kind, opt = {}, by = fromId()) {
  const a = readAssign(dir, id);
  if (!a) throw new Error(`${id}: 아직 배정 안 됨 — 먼저 assign <시트> <이슈#> <담당>`);
  const saved = readAnswers(dir, id);
  if (!answeredKeys(saved).includes(key)) throw new Error(`${id}: 문항 ${key} 는 답이 없다 — 답한 문항: ${answeredKeys(saved).join(' ') || '(없음)'}`);
  if (!ITEM_KINDS.includes(kind)) throw new Error(`문항 처리는 ${ITEM_KINDS.join(' · ')} 중 하나 (받은 값: ${kind})`);
  const rec = { kind, ans: ansHash(saved.answers[key]), at: new Date().toISOString(), by };
  const repo = opt.repo || a.repo || '';
  if (kind === 'done') {
    const rule = String(opt.rule || '').trim();
    if (rule && opt.pr) throw new Error(`${key} done 은 --pr 와 --rule 중 하나만`);
    if (rule) rec.rule = rule.slice(0, 300);
    else {
    const ref = parseRef(opt.pr, repo); if (!ref) throw new Error(`${key} done 은 --pr <번호> 또는 --rule "<근거 한 줄>" 필요`);
    const p = ghPull(ref); if (!p.merged) throw new Error(`${key}: PR ${refStr(ref)} 는 머지 안 됨 (${p.state || '?'})`);
    Object.assign(rec, { pr: refStr({ repo: p.repo, n: p.n }), url: p.url, mergedAt: p.mergedAt, title: p.title });
    }
  } else if (kind === 'defer') {
    const ref = parseRef(opt.issue, repo); if (!ref) throw new Error(`${key} defer 는 --issue <번호> 필요`);
    const i = ghIssue(ref); if (i.isPR) throw new Error(`${key}: ${refStr(ref)} 는 PR — 미룬 일은 이슈 번호로`);
    Object.assign(rec, { issue: refStr({ repo: i.repo, n: i.n }), url: i.url });
  } else if (kind === 'moved') {
    const to = String(opt.to || '');
    const t = to && listSheetsRaw(dir).find(s => !s.error && (s.name === to || s.id === to));
    if (!t) throw new Error(`${key} moved 는 옮긴 시트 이름이 필요 — 받은 값: ${to || '(없음)'}`);
    if (t.id === id) throw new Error(`${key}: 자기 시트로는 못 옮긴다`);
    rec.to = t.name;
  }
  if (opt.note) rec.note = String(opt.note).slice(0, 300);
  a.items = { ...(a.items || {}), [key]: rec };
  saveAssign(dir, id, a);
  return { a, rec, ...itemsOpen(dir, id, a, saved) };
}

/* 되돌림 감지 (#40) — 근거 PR(머지 단계·문항 done)이 나중에 revert 되면 '되돌림' 단계를 붙여 시트를 다시 연다.
   unassigned 가 부를 때만 gh 를 친다. PR 마다 everyMs(기본 1시간)에 한 번, 머지 뒤 maxDays(기본 14일)까지만 본다. */
export function checkReverts(dir, { everyMs = 3600e3, maxDays = 14, onError = () => {} } = {}) {
  let names = []; try { names = fs.readdirSync(assignDir(dir)).filter(f => f.endsWith('.json')); } catch { return []; }
  const found = [], now = Date.now();
  for (const f of names) {
    const id = f.slice(0, -5), a = readAssign(dir, id); if (!a) continue;
    const rv = revertedPrs(a), seen = a.revertChecked || {};
    const prs = [...epoch(a).filter(x => x.stage === '머지' && x.pr).map(x => ({ pr: x.pr, title: x.title, mergedAt: x.mergedAt })),
      ...Object.values(a.items || {}).filter(x => x.kind === 'done' && x.pr).map(x => ({ pr: x.pr, title: x.title, mergedAt: x.mergedAt }))]
      .filter((x, i, l) => l.findIndex(y => y.pr === x.pr) === i && !rv.has(x.pr));
    let dirty = false;
    for (const x of prs) {
      if (seen[x.pr] && now - Date.parse(seen[x.pr]) < everyMs) continue;
      if (x.mergedAt && now - Date.parse(x.mergedAt) > maxDays * 864e5) continue;
      const ref = parseRef(x.pr); if (!ref || !ref.repo) continue;
      let hit; try { hit = ghRevertOf({ ...ref, title: x.title, mergedAt: x.mergedAt }); } catch (e) { onError(e); continue; }
      seen[x.pr] = new Date().toISOString(); dirty = true;
      if (hit) {
        const r = refStr(hit);
        a.stages = [...(a.stages || []), { stage: '되돌림', note: `${r} 가 ${x.pr} 를 되돌림`, pr: r, reverts: x.pr, at: new Date().toISOString(), by: 'review-sheet' }];
        found.push({ id, pr: x.pr, by: r });
      }
    }
    if (dirty) { a.revertChecked = seen; saveAssign(dir, id, a); }
  }
  return found;
}
/** 이슈가 닫혔는지 — unassigned 가 단계 덜 된 배정만(검사 통과해 repo 가 남은 것), 이슈마다 everyMs 에 한 번 */
export function checkIssues(dir, { everyMs = 3600e3, onError = () => {} } = {}) {
  let names = []; try { names = fs.readdirSync(assignDir(dir)).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of names) {
    const id = f.slice(0, -5), a = readAssign(dir, id); if (!a) continue;
    const last = (a.stages || []).at(-1);
    if (last && FINAL_STAGES.has(last.stage)) continue;
    if (a.issueCheckedAt && Date.now() - Date.parse(a.issueCheckedAt) < everyMs) continue;
    const ref = parseRef(a.issue, a.repo || ''); if (!ref || !ref.repo) continue;   // 레포를 모르는 옛 배정은 묻지 않는다(지금 폴더 레포로 잘못 채워진다)
    try { const i = ghIssue(ref); a.issueState = i.state; a.issueCheckedAt = new Date().toISOString(); saveAssign(dir, id, a); } catch (e) { onError(e); }
  }
}

export const STATE_LABEL = { none: '배정없음', changed: '답바뀜', items: '문항안붙음', reverted: '되돌림' };
/** 시트 요약에 붙일 배정·단계 정보 — tag 는 받은편지함 시트 줄 맨 앞에 붙는 '끝난 상태'. */
function assignInfo(a) {
  if (!a) return null;
  const last = (a.stages || []).at(-1) || { stage: '배정', note: `${a.issue} → ${a.owner}`, at: a.at };
  return { issue: a.issue, owner: a.owner, stage: last.stage, tag: stageTag(last), off: !!last.off, eta: last.eta || '', note: last.note || '', stageAt: last.at, by: last.by || '',
    pr: last.pr || '', sha: last.sha || '' };
}
/* 장부 시작 (#40) — 문항 장부는 assign/.items-since 뒤에 (다시) 저장된 답부터. 그 전 답은 예전 규칙(배정 있으면 닫힘, 배정 뒤 답 바뀜 = 열림). */
export function itemsSince(dir) {
  const f = path.join(assignDir(dir), '.items-since');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* first use */ }
  const now = new Date().toISOString();
  fs.mkdirSync(assignDir(dir), { recursive: true }); fs.writeFileSync(f, now + '\n');
  return now;
}
/** null = 대상 아님(미제출·게이트 전 답) · 'none' 배정없음 · 'items' 문항 안 붙음 · 'changed' 배정 뒤 답 바뀜(장부 전 답) ·
 *  'reverted' 근거 PR 되돌려짐 · 'closed' 이슈는 닫혔는데 단계 덜 됨 · 'ok'. 예전 '멈춤(24h)'은 소음이라 뺐다(102건). */
export function assignState(dir, s, since, iSince = '9') {
  if (!s || s.error || !s.submitted) return null;
  const a = readAssign(dir, s.id);
  if (!a) return String(s.savedAt) >= String(since) ? 'none' : null;
  const last = (a.stages || []).at(-1) || { stage: '배정' };
  if (last.stage === '되돌림') return 'reverted';
  if (String(s.savedAt) >= String(iSince)) { if (itemsOpen(dir, s.id, a).open.length) return 'items'; }
  else if (String(s.savedAt) > String(a.at)) return 'changed';
  if (a.issueState === 'closed' && !FINAL_STAGES.has(last.stage)) return 'closed';
  return 'ok';
}

/* record (#40) — read 출력 전체(메모·추가 질문 _ask·문항 질문 포함)를 이슈 댓글로. 다시 저장된 뒤 또 부르면 아직 안 붙인 줄만 덧붙인다.
   붙인 줄의 해시는 record/<id>.json { "<repo>#N": { hashes, at } } 에 남는다. */
const recordFile = (dir, id) => path.join(dir, 'record', id + '.json');
export function recordText(dir, name) {
  const sheet = loadSheet(dir, name), saved = readAnswers(dir, sheet.id);
  let md = renderMarkdown(sheet, saved, dir);
  const asks = asksFor(dir, name);
  if (asks.length) md += '\n\n### 문항 질문\n\n' + asks.map(x => `- ${x.q} — hero: ${x.text.replace(/\s+/g, ' ')}` + x.replies.map(r => `\n  - ↩ ${r.from}: ${r.text.replace(/\s+/g, ' ')}`).join('')).join('\n');
  return { sheet, saved, md };
}
const lineHash = l => crypto.createHash('sha1').update(l).digest('hex').slice(0, 16);
export function recordPlan(md, posted = []) {
  const done = new Set(posted), lines = md.split('\n');
  const isContent = l => /^\| (?!# \|)(?!---)/.test(l) || /^> /.test(l) || /^- /.test(l) || /^  - /.test(l);
  if (!posted.length) return { body: md, hashes: lines.filter(isContent).map(lineHash), fresh: lines.filter(isContent).length };
  const out = []; let sec = '', head = [], secOut = false, fresh = 0;
  for (const l of lines) {
    if (/^### /.test(l)) { sec = l; head = []; secOut = false; continue; }
    if (/^\| # \|/.test(l) || /^\| --- /.test(l)) { head.push(l); continue; }
    if (!isContent(l) || done.has(lineHash(l))) continue;
    if (!secOut && sec) { out.push('', sec, ''); secOut = true; }
    if (/^\| /.test(l) && head.length && !out.includes(head[0], out.lastIndexOf(sec))) out.push(...head);
    out.push(l); fresh++;
  }
  return { body: out.join('\n').trim(), hashes: lines.filter(isContent).map(lineHash).filter(h => !done.has(h)), fresh };
}
export function recordSheet(dir, name, { issue, repo = '' } = {}) {
  const s = listSheetsRaw(dir).find(x => !x.error && (x.name === name || x.id === name));
  if (!s) throw new Error(`시트 ${name} 없음`);
  const a = readAssign(dir, s.id);
  let ref = parseRef(issue || (a && a.issue), repo || (a && a.repo) || '');
  if (!ref) throw new Error(`${s.name}: 붙일 이슈가 없다 — record <시트> --issue N`);
  const iss = ghIssue(ref); if (iss.isPR) throw new Error(`${refStr(ref)} 는 PR — 답은 이슈에 남긴다`);
  ref = { repo: iss.repo || ref.repo, n: ref.n };
  const { saved, md } = recordText(dir, s.name);
  if (!saved || !saved.savedAt) throw new Error(`${s.name}: 아직 제출 안 됨`);
  let book = {}; try { book = JSON.parse(fs.readFileSync(recordFile(dir, s.id), 'utf8')) || {}; } catch { /* 처음 */ }
  const key = refStr(ref), prev = book[key] || { hashes: [] };
  const plan = recordPlan(md, prev.hashes);
  if (prev.hashes.length && !plan.fresh) return { posted: false, key, fresh: 0 };
  const body = prev.hashes.length ? `## ${s.title} — 바뀐 답 (저장 ${saved.savedAt} · sheet \`${s.id}\`)\n${plan.body}` : plan.body;
  const c = ghApi(`${repoPath(ref.repo)}/issues/${ref.n}/comments`, { input: { body } }) || {};
  book[key] = { hashes: [...prev.hashes, ...plan.hashes], at: new Date().toISOString(), savedAt: saved.savedAt, url: c.html_url || (book[key] || {}).url || '' };
  fs.mkdirSync(path.dirname(recordFile(dir, s.id)), { recursive: true });
  fs.writeFileSync(recordFile(dir, s.id), JSON.stringify(book, null, 2) + '\n');
  return { posted: true, key, fresh: plan.fresh, url: c.html_url || '' };
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
// 바깥 링크 — 받은편지함 위 줄(진행판 → 자원 → 배치 →) 뒤에 붙는 외부 페이지 링크. 같은 label 은 덮어쓰고 나머지는 둠, url 이 빈 줄은 지움 (#47)
export const linksFile = dir => path.join(dir, 'links.json');
export function readLinks(dir) { try { const j = JSON.parse(fs.readFileSync(linksFile(dir), 'utf8')); return Array.isArray(j.links) ? j.links : []; } catch { return []; } }
export function writeLinks(dir, j) {
  if (!j || !Array.isArray(j.links)) throw new Error('links: {links:[{label,url}]} 필요');
  const cur = readLinks(dir);
  for (const l of j.links) {
    const label = typeof l?.label === 'string' ? l.label.trim().slice(0, 30) : '';
    if (!label) continue;
    const i = cur.findIndex(c => c.label === label);
    if (!l.url) { if (i >= 0) cur.splice(i, 1); continue; }
    if (!/^(https?:\/\/|\/(?!\/))/.test(String(l.url))) throw new Error(`links: ${label} — url 은 http(s) 나 받은편지함 안 경로(/…) 만`);
    const row = { label, url: String(l.url).slice(0, 300) };
    if (i >= 0) cur[i] = row; else cur.push(row);
  }
  if (cur.length > 8) throw new Error('links: 8개까지');
  const f = linksFile(dir), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ links: cur }, null, 1)); fs.renameSync(tmp, f);
  return cur;
}
// 자원판 — 바깥 생산자(예: fleet dash-collect)가 만든 dash.json 을 그대로 보여 주는 보기 전용 층. 숫자 카드 + 줄 목록, 줄을 누르면 그 줄의 시계열.
export const dashFile = dir => path.join(dir, 'dash.json');
const DASH_LEVELS = ['ok', 'warn', 'bad'];
const DASH_KINDS = ['claude', 'out', 'ctr', 'sys', 'used', 'free'];
export function cleanDash(j) {
  if (!j || !Array.isArray(j.cards) || !Array.isArray(j.groups)) throw new Error('dash: {cards:[…], groups:[…]} 필요');
  const str = (v, n = 120) => typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' ? String(v) : undefined;
  const series = {}, src = j.series && typeof j.series === 'object' ? j.series : {};
  for (const [k, s] of Object.entries(src).slice(0, 400)) {
    if (!s || !Array.isArray(s.values) || !Number.isFinite(s.start) || !(s.step > 0)) continue;
    series[k.slice(0, 120)] = { label: str(s.label), unit: str(s.unit, 12), start: s.start, step: s.step,
      values: s.values.slice(-2000).map(v => Number.isFinite(v) ? v : null) };
  }
  const refs = a => (Array.isArray(a) ? a : []).filter(k => typeof k === 'string' && series[k]).slice(0, 4);
  const num = v => Number.isFinite(v) ? v : undefined;
  const cols = a => (Array.isArray(a) ? a : []).slice(0, 4).map(c => ({ label: str(c && c.label, 30), value: str(c && c.value, 30), n: num(c && c.n) }));
  const cards = j.cards.slice(0, 16).filter(c => c && str(c.label)).map(c => ({ key: str(c.key), label: str(c.label, 40), value: str(c.value, 20), unit: str(c.unit, 8),
    sub: str(c.sub, 120), n: num(c.n), level: DASH_LEVELS.includes(c.level) ? c.level : 'ok', series: refs(c.series) }));
  const groups = j.groups.slice(0, 12).filter(g => g && Array.isArray(g.rows)).map(g => ({ title: str(g.title, 80),
    rows: g.rows.slice(0, 80).filter(r => r && str(r.label)).map(r => ({ key: str(r.key), label: str(r.label, 80), sub: str(r.sub, 160), cols: cols(r.cols), series: refs(r.series) })) }));
  // 막대 쌓기(root-dash-3 ②) — 전체 중 무엇이 얼마를 쓰고 얼마가 남았나. kind 는 색 이름표
  const bars = (Array.isArray(j.bars) ? j.bars : []).slice(0, 8).filter(b => b && str(b.label) && num(b.total) > 0).map(b => ({ label: str(b.label, 40), total: b.total, unit: str(b.unit, 8), sub: str(b.sub, 120),
    parts: (Array.isArray(b.parts) ? b.parts : []).slice(0, 8).filter(p => p && str(p.label) && num(p.value) >= 0).map(p => ({ label: str(p.label, 30), value: p.value, kind: DASH_KINDS.includes(p.kind) ? p.kind : 'sys' })) }));
  return { title: str(j.title, 80), source: str(j.source, 80), note: str(j.note, 200), scale: { week: num(j.scale && j.scale.week) }, updatedAt: str(j.updatedAt, 40) || new Date().toISOString(), cards, bars, groups, series };
}
export function writeDash(dir, j) {
  const d = cleanDash(j), f = dashFile(dir), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, f);
  return d;
}
export function readDash(dir) { try { return JSON.parse(fs.readFileSync(dashFile(dir), 'utf8')); } catch { return null; } }
/* 배치판 (#41, hero 시트 ops-script-3 C-1 「젠킨스 빌드기록 같은 뷰」) — 생산자(도메인)마다 batch/<도메인>.json.
   형식 pkch-batch-view/1: 위 {format, at, domain?, source?, state, tick, rules[], others?} · 규칙 {job, what, verdicts, owner, when, who_runs, on,
   every_min, next, last, total, health, runs[]} · 실행 {id, status, verdict, line, startedAt, endedAt, ms, log[{level,code,text}], file, want, taken{by,at,did}, waitingMin}.
   넣을 때마다 규칙 정보는 새것으로, 실행은 id 로 합쳐 더한다(같은 id 는 새것이 이김 — 나중에 taken 이 붙음). 규칙마다 새것부터 BATCH_KEEP 개만. 보기 전용 — 판은 일을 바꾸지 않는다. */
export const BATCH_KEEP = 50, BATCH_HEALTH = ['ok', 'late', 'broke', 'none'];
export const batchDir = dir => path.join(dir, 'batch');
const batchFile = (dir, dom) => path.join(batchDir(dir), dom + '.json');
export function batchDomain(j, flag) {
  const owner = j && Array.isArray(j.rules) && j.rules.map(r => r && r.owner).find(o => typeof o === 'string' && o.includes(':'));
  const d = String(flag || (j && j.domain) || (owner ? owner.split(':')[0] : '') || (j && typeof j.format === 'string' ? j.format.split('-')[0] : '')).toLowerCase();
  if (!ID_RE.test(d)) throw new Error('batch: 도메인을 모름 — --domain <이름> ([a-z0-9-])');
  return d;
}
export function cleanBatch(j) {
  if (!j || !Array.isArray(j.rules)) throw new Error('batch: {format, rules:[…]} 필요');
  const str = (v, n = 300) => typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' ? String(v) : undefined;
  const num = v => Number.isFinite(v) ? v : null;
  const map = (o, n) => o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).slice(0, 12).map(([k, v]) => [k.slice(0, 30), str(v, n) || ''])) : {};
  const run = r => ({ id: str(r.id, 120), status: r.status === 'error' ? 'error' : 'done', verdict: str(r.verdict, 30) || null, line: str(r.line, 500) || '',
    startedAt: str(r.startedAt, 40), endedAt: str(r.endedAt, 40), ms: num(r.ms), file: str(r.file, 200), want: !!r.want, waitingMin: num(r.waitingMin),
    log: (Array.isArray(r.log) ? r.log : []).slice(0, 40).filter(x => x && str(x.text)).map(x => ({ level: str(x.level, 12) || 'note', code: str(x.code, 40) || '', text: str(x.text, 600) })),
    taken: r.taken && typeof r.taken === 'object' && str(r.taken.by) ? { by: str(r.taken.by, 80), at: str(r.taken.at, 40), did: str(r.taken.did, 300) || '' } : null });
  const rules = j.rules.slice(0, 40).filter(r => r && str(r.job)).map(r => ({ job: str(r.job, 60), what: str(r.what, 400) || '', verdicts: map(r.verdicts, 200), owner: str(r.owner, 60),
    draft: !!r.draft, when: str(r.when, 300), who_runs: str(r.who_runs, 300), on: map(r.on, 500), every_min: num(r.every_min), next: str(r.next, 40) || null,
    last: str(r.last, 40) || null, total: num(r.total), fails: num(r.fails), last_error: str(r.last_error, 300) || null,
    health: BATCH_HEALTH.includes(r.health) ? r.health : 'none', runs: (Array.isArray(r.runs) ? r.runs : []).filter(x => x && str(x.id)).map(run) }));
  const others = (Array.isArray(j.others) ? j.others : []).slice(0, 40).filter(o => o && str(o.label)).map(o => ({ label: str(o.label, 80), pid: num(o.pid), status: str(o.status, 12) }));
  const tick = j.tick && typeof j.tick === 'object' ? { at: str(j.tick.at, 40), ran: (Array.isArray(j.tick.ran) ? j.tick.ran : []).map(x => str(x, 60)).filter(Boolean).slice(0, 40) } : null;
  return { format: str(j.format, 40), at: str(j.at, 40) || new Date().toISOString(), source: str(j.source, 80), state: str(j.state, 200), tick, rules, others };
}
export function writeBatch(dir, j, domain) {
  const dom = batchDomain(j, domain), b = cleanBatch(j), old = readBatch(dir, dom);
  const prev = new Map((old ? old.rules : []).map(r => [r.job, r.runs || []]));
  for (const r of b.rules) {
    const byId = new Map((prev.get(r.job) || []).map(x => [x.id, x]));
    for (const x of r.runs) byId.set(x.id, x);
    r.runs = [...byId.values()].sort((a, c) => String(c.startedAt || '').localeCompare(String(a.startedAt || ''))).slice(0, BATCH_KEEP);
  }
  b.domain = dom; b.receivedAt = new Date().toISOString();
  fs.mkdirSync(batchDir(dir), { recursive: true });
  const f = batchFile(dir, dom), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b)); fs.renameSync(tmp, f);
  return b;
}
export function readBatch(dir, dom) { try { return JSON.parse(fs.readFileSync(batchFile(dir, dom), 'utf8')); } catch { return null; } }
export function readBatches(dir) {
  let names = []; try { names = fs.readdirSync(batchDir(dir)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(n => ID_RE.test(n)).sort(); } catch { /* none */ }
  return names.map(n => readBatch(dir, n)).filter(Boolean);
}
/** 도메인의 main 채널 — owner 가 <도메인>:main 인 채널, root 면 허브 */
export function batchChat(root, dom) {
  const all = listChats(root);
  const c = all.find(c => c.owner === `${dom}:main`) || (dom === 'root' ? all.find(c => c.hub) : null) || all.find(c => String(c.owner).split(':')[0] === dom && !c.hub);
  return c ? c.name : null;
}

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
  if (saved && saved.savedAt && picked < n && !reportOf(sheet)) {
    const left = sheet.sections.flatMap(s => (s.questions || []).map(q => `${s.code}-${normQ(q).k}`)).filter(k => !(A[k] || {}).pick);
    out.splice(2, 0, `> ⚠ **부분 제출 — 안 고른 문항 ${left.length}개 (${left.join(', ')}).** 메모만 온 문항도 미결이다. 막힌 이유(메모·추가 질문)에 먼저 답하고, **남은 문항만 새 id 시트로 다시 묻는다**(전부 다시 보내지 않는다). 메모로 답이 충분하면 그대로 진행.`, '');
  }
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
  if (from) {
    // 'pkch:서버' 처럼 창 이름까지 붙은 from 은 그 도메인 매니저(:main) 채널로 — 허브로 새면 root 와 도메인이 같은 질문에 두 번 답한다 (hero 2026-10-18)
    const dom = String(from).split(':')[0];
    const c = all.find(c => c.name === from) || all.find(c => c.owner === from || String(c.owner).split(':')[0] === from)
      || all.find(c => c.owner === `${dom}:main`) || all.find(c => String(c.owner).split(':')[0] === dom && !c.hub);
    if (c) return c;
  }
  return all.filter(c => String(sheetName).startsWith(c.name + '-')).sort((a, b) => b.name.length - a.name.length)[0] || null;
}
/* 추가 질문 (hero 2026-10-13) — answers._ask.memo. 새로 쓰거나 바뀌면 담당 세션 채널에 hero 이름으로 알림, read 맨 위에 뜬다. */
const askOf = saved => (saved && saved.answers && saved.answers._ask && typeof saved.answers._ask.memo === 'string' && saved.answers._ask.memo.trim()) || '';
export function notifyAsk(root, id, text) {
  const s = listSheets(root).find(x => !x.error && x.id === id); if (!s) return null;
  const c = chatFor(path.resolve(root), s.from, s.name); if (!c) return null;
  appendChat(path.resolve(root), c.name, 'hero', `추가 질문 (시트 ${s.name} · ${s.title}): ${text}\n— 채팅 답장(--re 이 메시지)으로 답할 것. 물은 것마다 빠짐없이 — 짧게 줄이지 말 것(답장은 ${CHAT_REPLY_MAX}자까지). 질문이 여럿이면 번호 매겨 하나씩. 답이 일을 바꾸면 SoT 이슈에도 한 줄.`, null, null, { auto: true, wake: true });
  return c.name;
}

/* 답 저장 훅 (room #171) — 세션은 `wait` 로 기다리는 동안만 답을 안다. 대기가 끝나 있으면 놓치니, 답 파일을 쓴 직후 설치 쪽 훅을 부른다.
   전달: REVIEW_SHEET_ANSWER_HOOK(명령 경로)이 있으면 `hook <시트> <from> <답 파일 절대경로>` 를 떼어 실행
   (env REVIEW_SHEET_INBOX, REVIEW_SHEET_ANSWER_SUMMARY = '3/4 선택 · 메모 2' 같은 한 줄). 훅이 없으면 아무 일 없음.
   저장은 '제출' 버튼으로만 오지만 고쳐서 몇 초 안에 다시 내는 일이 있어 시트별 ANSWER_HOOK_GAP 안의 재저장은 한 번으로 묶는다
   — 첫 저장은 바로, 그 사이 저장들은 창이 끝날 때 한 번(그때 답 파일 = 마지막 답). 실패·시간 초과는 로그 한 줄, 저장·응답과 무관. */
const ANSWER_HOOK_GAP = 5000;
const answerHookAt = new Map();   // <root>/<시트 id> → { last, timer }
/** '3/4 선택 · 메모 2' — 고른 문항/전체, 메모 쓴 칸 수(전체 메모 포함). */
export function answerSummary(sheet, saved) {
  const A = (saved && saved.answers) || {};
  const qs = sheet.sections.flatMap(s => (s.questions || []).map(q => `${s.code}-${normQ(q).k}`));
  const memos = Object.values(A).filter(a => a && typeof a.memo === 'string' && a.memo.trim()).length;
  return `${qs.filter(k => A[k] && A[k].pick).length}/${qs.length} 선택${memos ? ` · 메모 ${memos}` : ''}`;
}
function runAnswerHook(root, id) {
  const hook = process.env.REVIEW_SHEET_ANSWER_HOOK; if (!hook) return;
  const s = listSheets(root).find(x => !x.error && x.id === id);
  let sum = '';
  try { if (s) sum = answerSummary(loadSheet(root, s.name), readAnswers(root, id)); } catch { /* 요약 없이 부른다 */ }
  let child;
  try {
    child = spawn(hook, [s ? s.name : id, (s && s.from) || '', answersFile(root, id)], { detached: true, stdio: 'ignore',
      env: { ...process.env, REVIEW_SHEET_INBOX: root, REVIEW_SHEET_ANSWER_SUMMARY: sum } });
  } catch (e) { console.error('answer hook:', e.message || e); return; }
  const timer = setTimeout(() => { console.error(`answer hook: ${id} 시간 초과`); try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* gone */ } } }, Number(process.env.REVIEW_SHEET_ANSWER_HOOK_MS) || 60000);   // 훅의 자식까지 그룹째
  timer.unref();
  child.on('error', e => { clearTimeout(timer); console.error('answer hook:', e.message || e); });
  child.on('exit', code => { clearTimeout(timer); if (code) console.error(`answer hook: ${id} exit ${code}`); });
  child.unref();
}
function answerHook(root, id) {
  if (!process.env.REVIEW_SHEET_ANSWER_HOOK) return;
  const k = path.join(root, id), st = answerHookAt.get(k) || { last: 0, timer: null };
  answerHookAt.set(k, st);
  if (st.timer) return;   // 창 끝에 이미 한 번 잡혀 있다
  const wait = st.last + ANSWER_HOOK_GAP - Date.now();
  if (wait <= 0) { st.last = Date.now(); return runAnswerHook(root, id); }
  st.timer = setTimeout(() => { st.timer = null; st.last = Date.now(); runAnswerHook(root, id); }, wait);
  st.timer.unref();
}

/* 문항 질문 (hero 2026-10-16, 2026-10-20 #64) — 시트 안 '＋ 이것만 묻기'. 그 문항 하나만 묻는다(제출·다른 답과 무관 — 시트는 계속 '답 기다리는 중').
   질문과 답은 시트 안에만 산다: inbox/asks/<시트>.jsonl
     질문 { id, ts, from: 'hero', q, label, text }   답 { id, ts, from, re: <질문 id>, text }
     기록 { id, ts, deliv: <질문 id>, via: 'hook'|'chat', ch?, code? }   { id, ts, staleSent: <질문 id>, ch }
   전달: REVIEW_SHEET_ASK_HOOK(명령 경로)이 있으면 `hook <시트> <from> <문항> <질문 id>` (질문 글 = stdin 과 env REVIEW_SHEET_ASK_TEXT)
   로 떼어 실행 — 시트를 쓴 창에 바로 넣는 일은 설치 쪽 훅이 한다. 훅이 없거나 0 아닌 값으로 끝나면(또는 시간 초과) 예전처럼
   담당 채널(없으면 허브)에 hero 이름으로 한 통 — 그 메시지의 ↩ 답장도 시트에 뜬다.
   답: review-sheet ask-reply <시트> <문항> "…" → asks 파일에. 답 없이 ASK_STALE_MS 지나면 담당 채널(없으면 허브)에 한 줄, 한 번만(askWatch).
   예전 시트의 문항 질문(채널 로그의 ask:{d,q,text}) 은 그대로 읽고, chat say --re 답장도 그대로 붙는다. */
const ASK_MAX = 2000;
const sheetByName = (root, name) => listSheets(root).find(x => !x.error && x.name === name) || null;
const askChans = (root, s) => [chatFor(root, s.from, s.name), hubChat(root)].filter((c, i, a) => c && a.findIndex(x => x && x.name === c.name) === i);
const asksDir = root => path.join(root, 'asks');
const asksFile = (root, name) => path.join(asksDir(root), name + '.jsonl');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function readAsksFile(root, name) {
  try { return fs.readFileSync(asksFile(root, name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function appendAsks(root, name, rec) {
  fs.mkdirSync(asksDir(root), { recursive: true });
  const r = { id: newId(), ts: new Date().toISOString(), ...rec };
  fs.appendFileSync(asksFile(root, name), JSON.stringify(r) + '\n');
  return r;
}
/** 훅이 없거나 실패했을 때: 예전처럼 담당 채널(없으면 허브)로 한 통. askRef 로 시트 질문과 이어 둔다(↩ 답장이 시트에 뜨게). */
function askToChat(root, s, a) {
  const c = askChans(root, s)[0]; if (!c) return null;
  const where = a.label ? ` 「${a.label}」` : '';
  const msg = appendChat(root, c.name, 'hero', `문항 질문 (시트 ${s.name} · ${a.q}${where}): ${a.text}\n— 이 문항 하나만 묻는 것(시트는 제출 안 됨). review-sheet ask-reply ${s.name} ${a.q} "…" (또는 chat say ${c.name} --re 이 메시지)로 답하면 시트 그 문항 밑에 바로 뜬다. 시트를 다시 보내지 말 것. 물은 것에 빠짐없이(${CHAT_REPLY_MAX}자까지).`,
    null, null, { auto: true, wake: true, askRef: { d: s.name, q: a.q, id: a.id } });
  return c.name;
}
export function askItem(root, name, q, label, text) {
  root = path.resolve(root);
  const s = sheetByName(root, name); if (!s) throw new Error(`시트 ${name} 없음`);
  q = String(q || '').trim(); text = String(text || '').trim();
  if (!/^[^\s]{1,64}$/.test(q)) throw new Error('문항 키가 이상합니다');
  if (!text) throw new Error('질문이 비었습니다'); if (text.length > ASK_MAX) throw new Error(`질문은 ${ASK_MAX}자까지`);
  const where = String(label || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const a = appendAsks(root, s.name, { from: 'hero', q, label: where, text });
  const fallback = code => {
    try { const ch = askToChat(root, s, a); appendAsks(root, s.name, { deliv: a.id, via: 'chat', ch, ...(code !== undefined ? { code } : {}) }); return ch; }
    catch (e) { console.error('ask:', e.message || e); return null; }
  };
  const hook = process.env.REVIEW_SHEET_ASK_HOOK;
  if (!hook) return { id: a.id, via: 'chat', ch: fallback() };
  let done = false;
  const finish = code => {
    if (done) return; done = true; clearTimeout(timer);
    if (code === 0) appendAsks(root, s.name, { deliv: a.id, via: 'hook' }); else fallback(code);
  };
  let child;
  try {
    child = spawn(hook, [s.name, s.from || '', q, a.id], { detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, REVIEW_SHEET_ASK_TEXT: text, REVIEW_SHEET_ASK_LABEL: where, REVIEW_SHEET_INBOX: root, REVIEW_SHEET_ASK_FILE: asksFile(root, s.name) } });
  } catch { return { id: a.id, via: 'chat', ch: fallback(-1) }; }
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* gone */ } } finish(-2); }, Number(process.env.REVIEW_SHEET_ASK_HOOK_MS) || 300000);   // 훅의 자식(fleet send 등)까지 그룹째 — 늦게 닿아 채널과 두 번 가지 않게
  timer.unref();
  child.on('error', () => finish(-1));
  child.on('exit', code => finish(code));
  child.stdin.on('error', () => {}); child.stdin.end(text);
  child.unref();
  return { id: a.id, via: 'hook', ch: null };
}
export function asksFor(root, name) {
  root = path.resolve(root);
  const s = sheetByName(root, name); if (!s) return [];
  const out = [], byChatMsg = new Map();
  const recs = readAsksFile(root, name);
  for (const m of recs) if (m.from === 'hero' && m.q && !m.re)
    out.push({ id: m.id, ch: null, q: m.q, label: m.label || '', text: m.text, ts: m.ts,
      replies: recs.filter(r => r.re === m.id && r.from !== 'hero').map(r => ({ from: r.from, ts: r.ts, text: r.text })) });
  for (const c of askChans(root, s)) {
    const log = readChatLog(root, c.name);
    for (const m of log) {
      if (m.from !== 'hero') continue;
      if (m.askRef && m.askRef.d === name) { byChatMsg.set(m.id, { ch: c.name, log, ask: m.askRef.id }); continue; }
      if (m.ask && m.ask.d === name)   // 예전 시트: 질문이 채널 로그에 산다
        out.push({ id: m.id, ch: c.name, q: m.ask.q, label: m.ask.label || '', text: m.ask.text, ts: m.ts,
          replies: log.filter(r => r.re === m.id && r.from !== 'hero' && !r.askStale).map(r => ({ from: r.from, ts: r.ts, text: r.text })) });
    }
  }
  for (const [mid, { log, ask }] of byChatMsg) {   // 채널로 넘어간(훅 없음·실패) 질문의 ↩ 답장도 시트에
    const a = out.find(x => x.id === ask && !x.ch); if (!a) continue;
    for (const r of log) if (r.re === mid && r.from !== 'hero' && !r.askStale) a.replies.push({ from: r.from, ts: r.ts, text: r.text });
    a.replies.sort((x, y) => x.ts < y.ts ? -1 : 1);
  }
  return out.sort((a, b) => a.ts < b.ts ? -1 : 1);
}
/** 세션이 답할 때: 그 문항의 가장 최근 질문(답 없는 것 우선)에 ↩ 답장으로 붙인다. 새 질문 → asks 파일, 예전 질문 → 그 채널 */
export function askReply(root, name, q, text, from) {
  root = path.resolve(root);
  const all = asksFor(root, name).filter(a => a.q === q); if (!all.length) throw new Error(`시트 ${name} 문항 ${q} 에 온 질문 없음 — asks ${name} 로 확인`);
  const a = [...all].reverse().find(x => !x.replies.length) || all.at(-1);
  if (a.ch) { const meta = readChatMeta(root, a.ch); return { ch: a.ch, re: a.id, msg: appendChat(root, a.ch, from || meta.owner || a.ch, String(text), null, a.id) }; }
  const s = sheetByName(root, name);
  return { ch: `asks/${name}`, re: a.id, msg: appendAsks(root, name, { from: from || (s && s.from) || 'session', re: a.id, text: String(text) }) };
}
export function askWatch(root, ms = Number(process.env.REVIEW_SHEET_ASK_MS) || 60000, stale = Number(process.env.REVIEW_SHEET_ASK_STALE_MS) || 600000) {
  const tick = () => {
    try {
      root = path.resolve(root);
      const now = Date.now(), old = ts => now - Date.parse(ts) < stale || now - Date.parse(ts) > 864e5;
      let files = []; try { files = fs.readdirSync(asksDir(root)).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)); } catch { /* none */ }
      for (const name of files) {
        const recs = readAsksFile(root, name);
        const open = recs.filter(m => m.from === 'hero' && m.q && !m.re && !old(m.ts) && !recs.some(r => r.staleSent === m.id));
        if (!open.length) continue;
        const s = sheetByName(root, name); if (!s) continue;
        const answered = new Set(asksFor(root, name).filter(a => a.replies.length).map(a => a.id));
        for (const m of open) {
          if (answered.has(m.id)) continue;
          const c = askChans(root, s)[0]; if (!c) continue;
          appendChat(root, c.name, 'hero', `문항 질문 답 없음 ${Math.round((now - Date.parse(m.ts)) / 60000)}분 (시트 ${name} · 문항 ${m.q}) — review-sheet ask-reply ${name} ${m.q} "…" 로 답하거나 담당 창 확인`, null, null, { auto: true, wake: true, askStale: m.id });
          appendAsks(root, name, { staleSent: m.id, ch: c.name });
        }
      }
      const hub = hubChat(root); if (!hub) return;   // 예전 시트: 채널 로그에 사는 질문
      for (const c of listChats(root)) {
        const log = readChatLog(root, c.name);
        for (const m of log) {
          if (m.from !== 'hero' || !m.ask || m.askStaleSent || old(m.ts)) continue;
          if (log.some(r => r.re === m.id && r.from !== 'hero')) continue;
          const hl = readChatLog(root, hub.name);
          if (hl.some(r => r.askStale === m.id)) continue;
          appendChat(root, hub.name, 'hero', `문항 질문 답 없음 ${Math.round((now - Date.parse(m.ts)) / 60000)}분 (채널 ${c.name} #${m.id} · 시트 ${m.ask.d} · ${m.ask.q}): ${m.ask.text}\n— 담당 세션을 깨우거나 대신 답할 것: review-sheet ask-reply ${m.ask.d} ${m.ask.q} "…"`, null, null, { auto: true, wake: true, askStale: m.id });
        }
      }
    } catch (e) { console.error('ask:', e.message || e); }
  };
  const t = setInterval(tick, ms); t.unref();
  return () => clearInterval(t);
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
        : `긴급 해제: ${s.title} (시트 ${s.name}) — 평소 순서로. SoT 이슈의 긴급 라벨 제거.`, null, null, { auto: true, wake: true });
      notified = c.name;
    }
  }
  return { ok: true, name, urgent: !!on, notified };
}
/* 시트 요약 캐시 (hero 2026-10-11 "리뷰시트 느려졌어") — 시트가 500개를 넘자 받은편지함을 열 때마다(그리고 5초 새로고침마다)
   모든 data.js 를 vm 으로 돌리고 answers 를 읽어 1초 넘게 걸렸다. data.js·answers 의 mtime 이 그대로면 지난 요약을 쓴다. */
const summaryCache = new Map();   // <dir>/<name> → { key, sum }
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
/* 요약 캐시를 디스크에도 둔다 (2026-10-17) — 메모리 캐시는 서버 안에서만 산다. CLI(ls·stage·assign…)는 부를 때마다 새 프로세스라
   모든 data.js 를 vm 으로 다시 돌렸고, 영상을 base64 로 박은 시트(개당 30~46MB, 13개 350MB)까지 읽어 한 번에 RSS 3.7GB → 맥 스왑 급증·HOLD.
   <dir>/.summary-cache.json 에 { name: { dataM, ansM, sum } } — mtime 이 그대로인 시트는 data.js 를 열지 않는다. */
const summaryFile = dir => path.join(dir, '.summary-cache.json');
const diskLoaded = new Set();
function loadDiskCache(dir) {
  const d = path.resolve(dir); if (diskLoaded.has(d)) return; diskLoaded.add(d);
  let j = {}; try { j = JSON.parse(fs.readFileSync(summaryFile(dir), 'utf8')) || {}; } catch { return; }
  for (const [name, v] of Object.entries(j)) if (!summaryCache.has(path.join(d, name))) summaryCache.set(path.join(d, name), v);
}
function saveDiskCache(dir, names) {
  const d = path.resolve(dir), out = {};
  for (const name of names) { const v = summaryCache.get(path.join(d, name)); if (v) out[name] = v; }
  try { const tmp = summaryFile(dir) + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, summaryFile(dir)); } catch { /* 읽기 전용이어도 동작은 같다 */ }
}
function listSheetsRaw(dir) {
  loadDiskCache(dir);
  let dirty = false;
  const urgent = readUrgent(dir), checked = readChecked(dir);
  const live = (name, sum, dataM) => ({ ...sum, dataAt: dataM ? new Date(dataM).toISOString() : null, urgent: !!urgent[name], urgentAt: urgent[name] || null, checkedAt: sum.report && checked[name] || null });
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-data.js')).sort();
  const out = files.map(f => {
    const name = f.slice(0, -'-data.js'.length);
    const ck = path.join(path.resolve(dir), name), hit = summaryCache.get(ck), dataM = mtimeOf(path.join(dir, f));
    if (hit && hit.dataM === dataM && (hit.sum.error || (hit.ansM === mtimeOf(answersFile(dir, hit.sum.id)) && hit.ckd === !!checked[name])))
      return hit.sum.error ? hit.sum : live(name, hit.sum, dataM);
    dirty = true;
    try {
      const sheet = loadSheet(dir, name);
      const saved = readAnswers(dir, sheet.id);
      const qs = sheet.sections.flatMap(s => (s.questions || []).map(q => `${s.code}-${normQ(q).k}`));
      const picked = qs.filter(k => saved && saved.answers && saved.answers[k] && (saved.answers[k].pick || saved.answers[k].memo || (saved.answers[k].files || []).length)).length;
      const unpicked = qs.filter(k => !(saved && saved.answers && saved.answers[k] && saved.answers[k].pick)).length;
      let createdAt = sheet.createdAt || null;
      if (!createdAt) { try { createdAt = fs.statSync(path.join(dir, f)).mtime.toISOString(); } catch { /* ignore */ } }
      const savedAt = saved && saved.savedAt || null;
      const rep = reportOf(sheet, { checked: !!checked[name] });
      const sum = { name, id: sheet.id, title: rep ? rep.title : sheet.title || sheet.id, from: sheet.from || '', createdAt,
               total: qs.length, picked, savedAt, submitted: !!savedAt, report: rep ? rep.label : '' };
      // 부분 제출 (hero 2026-10-15) — 제출됐는데 고르지 않은 문항(메모만 포함)이 남음 = 미결. 배지로만 보이고(hero 의 '답 기다림' 칸엔 안 올림 —
      // 남은 문항은 세션 몫), read/wait 출력과 unassigned 가 세션에게 '남은 문항만 새 시트로' 를 알린다
      if (savedAt && !rep && unpicked) sum.partial = unpicked;
      summaryCache.set(ck, { dataM, ansM: mtimeOf(answersFile(dir, sheet.id)), ckd: !!checked[name], sum });
      return live(name, sum, dataM);
    } catch (e) { const sum = { name, error: String(e.message || e) }; summaryCache.set(ck, { dataM, sum }); return sum; }
  });
  if (dirty) saveDiskCache(dir, files.map(f => f.slice(0, -'-data.js'.length)));
  return sortQueue(out);
}

/* 최근순 (hero 2026-10-23 "리뷰시트 정렬좀 최근순으로") — 마지막 움직임 = createdAt · data.js 수정 · 답 제출(savedAt) · ✓ 확인(checkedAt) · 단계 갱신(assign.stageAt)
   중 가장 늦은 것. 문자열 비교는 '+09:00' 과 'Z' 가 섞이면 순서가 틀려서(18:30+09:00 = 09:30Z 가 09:57Z 위로) Date.parse 로 ms 비교한다. */
const tsMs = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
export const activityMs = s => Math.max(tsMs(s.createdAt), tsMs(s.dataAt), tsMs(s.savedAt), tsMs(s.checkedAt), tsMs(s.assign && s.assign.stageAt));
function sortQueue(list) {
  // queue order: errors first (they need fixing), then pending, then submitted — 각 묶음 안에서 🔥 긴급 먼저, 그다음 마지막 움직임 최신순
  const g = x => x.error ? 0 : x.submitted ? 2 : 1;
  return list.map(s => s.error ? s : { ...s, activeAt: new Date(activityMs(s) || 0).toISOString() })
    .sort((a, b) => (g(a) - g(b)) || (!!b.urgent - !!a.urgent) || (activityMs(b) - activityMs(a)) || String(a.name).localeCompare(String(b.name)));
}

function listSheets(dir) {   // 배정·단계는 자주 바뀌고 파일이 몇 개 안 되니 캐시 밖에서 붙인다
  let names = []; try { names = fs.readdirSync(assignDir(dir)).filter(f => f.endsWith('.json')); } catch { /* 게이트 안 씀 */ }
  const by = new Map(names.map(f => [f.slice(0, -5), f]));
  return sortQueue(listSheetsRaw(dir).map(s => s.error || !by.has(s.id) ? s : { ...s, assign: assignInfo(readAssign(dir, s.id)) }));
}

/* 받은편지함 첫 화면: 답 기다리는 시트는 전부, 제출된 시트는 최근 RECENT_DONE 개만. 나머지는 '지난 시트 더 보기'(all=1) 때. */
const RECENT_DONE = 20;
function inboxSheets(dir, all) {
  const handled = s => !s.error && (s.submitted || !!s.checkedAt);   // 보고 시트는 ✓ 확인 체크도 끝남
  const sheets = listSheets(dir), done = sheets.filter(handled);
  // 제출된 시트도 마지막 움직임(제출·확인·단계 보고 포함) 최신순 — 상태가 바뀐 시트가 위로 (hero 2026-10-14, 10-23)
  done.sort((a, b) => (!!b.urgent - !!a.urgent) || (activityMs(b) - activityMs(a)));
  const open = sheets.filter(s => !handled(s));
  return { sheets: open.concat(all ? done : done.slice(0, RECENT_DONE)), doneTotal: done.length, all: !!all || done.length <= RECENT_DONE };
}

/* ── 상시 채널 (chat) ───────────────────────────────────────────────────────────
   inbox/chat/<ch>.json   meta  { name, title, owner, createdAt, seenAt (owner read up to), heroSeenAt }
   inbox/chat/<ch>.jsonl  one message per line { id, ts, from: 'hero'|<owner>, text, files?: [name], re?: id, kind?: issue|bug|followup }
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
/* 메시지 종류(hero 2026-10-18): 한 채널에 요구가 섞이면 세션이 맥락을 잃고, 제기한 이슈가 컴팩트 뒤 사라졌다.
   페이지 '고급' 칩으로 고르면 kind 가 실리고, chat wait/read 가 [태그] + 세션이 할 일 한 줄을 붙여 준다. 없으면 평문(지금 그대로). */
export const CHAT_KINDS = {
  issue: { tag: '이슈제기', todo: '— 이슈 제기: 불명확해도 먼저 SoT 이슈를 만들고(정본 room 레포) 답장에 링크. 애매한 점은 그 뒤에 묻고 본문을 고쳐 쓴다. 컴팩트해도 사라지지 않게.' },
  bug: { tag: '버그제보', todo: '— 버그 제보: bug 라벨 이슈 만들고 바로 고친다. 답장에 링크.' },
  followup: { tag: '지난이슈확인', todo: '— 지난 이슈 확인: 관련 이슈를 찾아 현재 상태(진행·막힘·끝남)부터 답한다. 이슈가 없으면 지금 만든다.' },
};
const wakesOwner = m => m.from === 'hero' && (m.wake === true || !!m.ask || !!m.askRef || !!m.askStale ||
  /^🔥 긴급 지정:|^긴급 해제:|^추가 질문 \(시트 /.test(m.text || '') || !m.auto);
function formatChat(root, ch, m) {
  const k = Object.hasOwn(CHAT_KINDS, m.kind || '') ? CHAT_KINDS[m.kind] : null;
  return `#${m.id} ${m.ts.replace('T', ' ').slice(0, 16)}  ${m.from === 'hero' ? 'hero' : m.from}: ${k ? `[${k.tag}] ` : ''}${m.re ? `↩#${m.re} ` : ''}${m.text}` +
    (m.files || []).map(f => `\n  [이미지] ${chatFilePath(root, ch, f)}`).join('') + (k ? `\n  ${k.todo}` : '');
}
const unseenHero = (root, ch, predicate) => {
  const { seenAt, seenId } = readChatMeta(root, ch) || {};
  const log = readChatLog(root, ch);
  const index = seenId ? log.findIndex(m => m.id === seenId) : -1;
  return log.filter((m, i) => predicate(m) && (index >= 0 ? i > index : !seenAt || m.ts > seenAt));
};
const freshHero = (root, ch) => unseenHero(root, ch, wakesOwner);
export function appendChat(root, ch, from, text, files, re, extra) {
  const meta = readChatMeta(root, ch); if (!meta) throw new Error(`채널 ${ch} 없음`);
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), from, text: String(text), ...(extra || {}) };
  if (files && files.length) msg.files = files;
  const log = readChatLog(root, ch);
  if (re) { if (!MSG_ID_RE.test(String(re)) || !log.some(m => m.id === re)) throw new Error(`답장 원문 ${re} 없음 — chat read ${ch} --all 의 #id`); msg.re = String(re); }
  const last = log.at(-1);   // same sender + same text + same files within 3s = a double send, keep the first
  if (last && last.from === from && last.text === msg.text && (last.re || null) === (msg.re || null) && (last.kind || null) === (msg.kind || null) &&
    JSON.stringify(last.files || []) === JSON.stringify(msg.files || []) && JSON.stringify(last.askRef || null) === JSON.stringify(msg.askRef || null) &&
    (last.wake === true) === (msg.wake === true) && (last.auto === true) === (msg.auto === true) && Date.now() - Date.parse(last.ts) < 3000) return last;
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
    const seenIndex = meta.seenId ? log.findIndex(m => m.id === meta.seenId) : -1;
    const unreadOwner = log.filter((m, i) => m.from === 'hero' && (seenIndex >= 0 ? i > seenIndex : !meta.seenAt || m.ts > meta.seenAt)).length;
    return { ...meta, hub: !!meta.hub, count: log.length, last, unreadHero, unreadOwner };
  }).filter(Boolean).sort((a, b) => (b.hub - a.hub) || (!!b.manager - !!a.manager));   // 허브 → 매니저(meta.manager, 일 분배 세션) → 일반
}
export function markSeen(root, ch, who, messages = []) {
  const meta = readChatMeta(root, ch); if (!meta) return null;
  if (who === 'hero') meta.heroSeenAt = new Date().toISOString();
  else {
    const last = messages.filter(m => m.from === 'hero').at(-1);
    if (!last) return meta;
    meta.seenAt = last.ts;
    meta.seenId = last.id;
  }
  writeChatMeta(root, meta); return meta;
}

/* Per channel + prefix set, remember answer content rather than file mtime/savedAt.
   A save with the same answers or a draft is not a new submission; _ask changes are questions. */
const waitAnyDir = root => path.join(root, 'wait-any');
const waitAnyFile = (root, ch, prefixes) => path.join(waitAnyDir(root), `${ch}-${crypto.createHash('sha256').update(JSON.stringify(prefixes)).digest('hex').slice(0, 16)}.json`);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const answerHash = saved => crypto.createHash('sha256').update(JSON.stringify(canonical(saved.answers || {}))).digest('hex');
function matchingSubmissions(root, prefixes) {
  if (!prefixes.length) return [];
  return listSheets(root).filter(s => !s.error && s.submitted && prefixes.some(p => s.name.startsWith(p)))
    .map(s => { const saved = readAnswers(root, s.id); return saved?.savedAt ? { ...s, saved, hash: answerHash(saved) } : null; }).filter(Boolean);
}
function saveWaitAnyState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(tmp, file);
}
const writeOutput = output => new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
async function waitAny(root, ch, flags) {
  if (!readChatMeta(root, ch)) { console.error(`채널 ${ch} 없음 — chat new <ch>`); process.exit(1); }
  const timeout = flags.timeout === undefined ? 3600 : flags.timeout;
  const settle = flags.settle === undefined ? 20 : flags.settle;
  if (![timeout, settle].every(n => Number.isFinite(n) && n >= 0)) usage();
  const prefixes = flags.sheets === undefined ? [] : [...new Set(flags.sheets.split(',').map(p => p.trim()))].sort();
  if (prefixes.includes('')) usage();
  const file = waitAnyFile(root, ch, prefixes);
  let state = { version: 1, ch, prefixes, submissions: {} };
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || saved.ch !== ch || JSON.stringify(saved.prefixes) !== JSON.stringify(prefixes) ||
        !saved.submissions || Array.isArray(saved.submissions) || typeof saved.submissions !== 'object' ||
        !Object.values(saved.submissions).every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new Error('invalid shape');
      state = saved;
    } catch {
      const quarantine = `${file}.corrupt.${Date.now()}.${process.pid}`;
      fs.renameSync(file, quarantine);
      console.error(`wait-any 상태 파일 손상 — ${quarantine} 격리; 제출 재통지`);
    }
  }
  const sheets = new Map();
  const deadline = Date.now() + timeout * 1000;
  let settleUntil = null;
  const messages = new Map();
  console.error(`waiting for hero on #${ch}${prefixes.length ? ` and sheets ${prefixes.join(',')}` : ''} (timeout ${timeout}s, settle ${settle}s)…`);
  while (true) {
    for (const m of freshHero(root, ch)) messages.set(m.id, m);
    for (const s of matchingSubmissions(root, prefixes)) {
      if (state.submissions[s.name] !== s.hash) {
        state.submissions[s.name] = s.hash;
        sheets.set(s.name, { savedAt: s.saved.savedAt, text: renderMarkdown(loadSheet(root, s.name), s.saved, root) });
      }
    }
    if (settleUntil === null && (messages.size || sheets.size)) settleUntil = Date.now() + settle * 1000;
    if (settleUntil !== null && Date.now() >= settleUntil) break;
    if (settleUntil === null && Date.now() >= deadline) { console.error('timeout'); process.exit(3); }
    await new Promise(r => setTimeout(r, Math.min(1000, Math.max(1, (settleUntil ?? deadline) - Date.now()))));
  }
  const output = [
    ...[...messages.values()].map(m => formatChat(root, ch, m)),
    ...[...sheets].map(([name, s]) => `SUBMITTED: ${name} ${s.savedAt}\n${s.text}`),
  ];
  await writeOutput(output.join('\n') + '\n');
  saveWaitAnyState(file, state);
  if (messages.size) markSeen(root, ch, 'owner', [...messages.values()]);
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
/* 다른 맥에 넘기기 — REVIEW_SHEET_STT_REMOTE(예: pkch 큐 http://127.0.0.1:5610/stt)가 whisper-server 와 같은 /inference 몸을 받아
   tailnet 안의 다른 맥이 전사한다(hero 2026-10-18 sheet-drops-1b C①). 503·시간 초과·실패면 이 맥 whisper 로 떨어진다. 이 맥에서 wav 로 바꾼 뒤 보낸다. */
const sttRemote = () => process.env.REVIEW_SHEET_STT_REMOTE || '';
export async function sttRemoteReady(base = sttRemote()) {
  if (!base) return false;
  try { return (await fetch(base + '/ready', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
function sttForm(wav, c, live) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'in.wav');
  fd.append('response_format', 'text'); fd.append('language', c.lang);
  fd.append('beam_size', live ? '1' : '5'); fd.append('best_of', live ? '1' : '5');
  if (c.vocab.length && !live) fd.append('prompt', c.vocab.join(', '));   // 짧은 조각에 단어장을 주면 단어장을 그대로 읊는다
  return fd;
}
async function sttServerInfer(me, wav, c, live) {
  const r = await fetch(`http://127.0.0.1:${me.port}/inference`, { method: 'POST', body: sttForm(wav, c, live), signal: AbortSignal.timeout(300e3) });
  if (!r.ok) throw new Error('whisper-server HTTP ' + r.status);
  return r.text();
}
async function sttRemoteInfer(base, wav, c, live) {
  const r = await fetch(base, { method: 'POST', body: sttForm(wav, c, live), signal: AbortSignal.timeout(live ? 15e3 : 120e3) });
  if (!r.ok) throw new Error('remote STT HTTP ' + r.status);
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
      if (sttRemote()) out = await sttRemoteInfer(sttRemote(), wav, c, live).catch(() => null);
      const srv = out == null ? await sttServer(c).catch(() => null) : null;
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

/* 탭 제목 앞 접두어(#51) — 여러 머신 받은편지함을 한 브라우저에서 같이 쓸 때 탭을 구분한다(hero 2026-10-19 '에어').
   REVIEW_SHEET_TAB_PREFIX 를 주면 HTML 의 </title> 뒤에 작은 스크립트를 넣어, 페이지가 제목을 바꿔도 앞에 다시 붙인다.
   탭 아이콘(hero 2026-10-19 '구맥' + 아이콘): icon 이 있으면 그 이모지를 그린 SVG favicon 을 같은 자리에 넣고 기존 icon 링크는 뺀다. */
const TAB_ICON_MAX = 4;   // 글자(그래핌) 수 — 이모지 하나 또는 짧은 글자
const graphemes = s => { try { return [...new Intl.Segmenter().segment(s)].length; } catch { return [...s].length; } };
export function tabFile(dir) { return path.join(path.resolve(dir), 'tab.json'); }
export function readTabFile(dir) {
  try { const j = JSON.parse(fs.readFileSync(tabFile(dir), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
/** 탭 이름표 설정 — <inbox>/tab.json {prefix, icon} 을 매번 읽고(서버 재시작 없이 반영), env REVIEW_SHEET_TAB_PREFIX/ICON 이 있으면 그게 이긴다. */
export function tabConfig(dir) {
  const f = dir ? readTabFile(dir) : {}, str = v => typeof v === 'string' ? v.trim() : '';
  const prefix = str(process.env.REVIEW_SHEET_TAB_PREFIX) || str(f.prefix);
  let icon = str(process.env.REVIEW_SHEET_TAB_ICON) || str(f.icon);
  if (graphemes(icon) > TAB_ICON_MAX) icon = '';
  return { prefix, icon };
}
export function faviconLink(icon) {
  const x = String(icon).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="80" text-anchor="middle" dominant-baseline="central">${x}</text></svg>`;
  return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}">`;
}
export function tabPrefixed(html, prefix = process.env.REVIEW_SHEET_TAB_PREFIX || '', icon = '') {
  const p = String(prefix || '').trim(), ic = String(icon || '').trim(); if (!p && !ic) return html;
  let s = String(html); if (s.indexOf('</title>') < 0) return html;
  if (ic) s = s.replace(/<link\b[^>]*\brel=["']?(?:shortcut )?icon["']?[^>]*>/gi, '');   // 우리 아이콘이 이기게 — 기존 icon 링크 제거(apple-touch-icon 은 둔다)
  const i = s.indexOf('</title>');
  let add = '';
  if (ic) add += faviconLink(ic);
  if (p) {
    const P = JSON.stringify(p + ' · ').replace(/</g, '\\u003c');
    add += `<script>(()=>{const P=${P};const f=()=>{if(!document.title.startsWith(P))document.title=P+document.title};f();const t=document.querySelector('title');if(t)new MutationObserver(f).observe(t,{childList:true,characterData:true,subtree:true})})()</script>`;
  }
  return s.slice(0, i + 8) + add + s.slice(i + 8);
}
function send(res, code, type, body, extra = {}) {
  if (String(type).startsWith('text/html')) { const t = tabConfig(res.rsRoot); if (t.prefix || t.icon) body = tabPrefixed(body, t.prefix, t.icon); }
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
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="리뷰시트"><script src="/push.js" defer></script><script src="/keys.js" defer></script>
<title>review-sheet</title><link rel="stylesheet" href="/sheet.css">
<body class="rs-page"><main><div class="eyebrow">REVIEW-SHEET · 받은편지함</div><h1>답변 시트</h1>
<p class="lede">${esc(dir)} · <span id="rs-upd"></span> <button type="button" class="rs-refresh" id="rs-refresh" title="목록 새로고침">↻ 새로고침</button> <a class="rs-boardlink" href="/board">진행판 →</a> <a class="rs-boardlink" href="/dash">자원 →</a> <a class="rs-boardlink" href="/batch">배치 →</a> ${readLinks(dir).map(l => `<a class="rs-boardlink" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} →</a> `).join('')}<span id="rs-push"></span> <span class="rs-kbhint" title="⌘J 커서 켜기/끄기 · ↓↑ jk 이동 · Tab 다음 묶음 · Enter 열기 · ⌘Enter 새 탭 · x 확인 · f 긴급 · Esc 끄기 · 채널·메모에서도 ⌘J 메시지 커서 + r 답장 · f/b 10개씩 · 맨 아래에서 ↓ = 입력칸 (시트·채널에선 Esc = 여기로)">⌨ ⌘J 키보드</span></p><div id="rs-list"></div></main>
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
    '<span class="rs-badge' + (s.assign ? ' rs-tag ' + tagKind(s.assign) : s.report ? ' rs-rep' : '') + '">' + (s.urgent ? '🔥 긴급 · ' : '') + (s.assign ? esc(s.assign.tag) : s.report ? esc(s.report) : s.partial ? '◐ 부분 제출 · 미선택 ' + s.partial : s.submitted ? '✓ 제출됨' : '답 기다림') + '</span><b>' + esc(s.title) + '</b>' +
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

/* 폰 알림 감시 (hero 2026-10-16) — 구독이 있을 때만 몇 초마다 받은편지함을 훑어, 새로 온 시트만 알린다(보고 시트는 🔀 머지됨 같은 배지를 앞에).
   채널 글은 안 알린다(hero 2026-10-16 "모든 메세지에 알림 보내지 말고 리뷰 시트 올때만"). 이미 제출된 시트도 안 알린다.
   서버를 켠 뒤 생긴 것만(켜기 전 것은 한꺼번에 몰려오지 않게). 5건 넘게 몰리면 한 건으로 묶는다. */
export function pushWatch(root, ms = Number(process.env.REVIEW_SHEET_PUSH_MS) || 8000) {
  let seen = null, busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      if (!readSubs(root).length) { seen = null; return; }   // 구독 없으면 훑지도 않는다
      const sheets = listSheetsRaw(root).filter(x => !x.error);
      if (!seen) { seen = new Set(sheets.map(x => x.name)); return; }
      const ev = [];
      for (const x of sheets) {
        if (seen.has(x.name)) continue; seen.add(x.name);
        if (!x.submitted) ev.push({ title: (x.report || '📝 새 시트') + (x.from ? ' · ' + x.from : ''), body: x.title, url: '/sheet.html?d=' + encodeURIComponent(x.name), tag: 'sheet-' + x.name });
      }
      if (!ev.length) return;
      const msgs = ev.length > 5 ? [{ title: '리뷰시트 새 소식 ' + ev.length + '건', body: ev.slice(0, 3).map(e => e.title + ' ' + e.body).join(' / ').slice(0, 160), url: '/', tag: 'many' }] : ev;
      for (const m of msgs) await pushAll(root, m);
    } catch (e) { console.error('push:', e.message || e); } finally { busy = false; }
  };
  const t = setInterval(tick, ms); t.unref(); tick();
  return () => clearInterval(t);
}

export function startServer(dir, port = 0, host = '127.0.0.1') {
  const root = path.resolve(dir);
  fs.mkdirSync(path.join(root, 'answers'), { recursive: true });
  const server = http.createServer((req, res) => {
    res.rsRoot = root;   // send() 가 <root>/tab.json 탭 이름표를 읽는다
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
            // 고른 것·메모·파일이 하나도 없는 제출은 받지 않는다 — 빈 답이 「제출됨」으로 넘어가 대기 목록에서 사라졌다 (#43)
            if (!Object.values(json.answers || {}).some(a => a && (a.pick || (typeof a.memo === 'string' && a.memo.trim()) || (a.files || []).length)))
              return send(res, 400, 'text/plain; charset=utf-8', 'empty answers — 고른 것·메모·파일이 하나도 없음');
            for (const a of Object.values(json.answers || {})) if (a && typeof a === 'object') { const f = cleanFiles(root, id, a.files); if (f.length) a.files = f; else delete a.files; }
            json.savedAt = new Date().toISOString();
            const file = answersFile(root, id);
            const prevAsk = askOf(readAnswers(root, id));
            fs.writeFileSync(file + '.tmp', JSON.stringify(json, null, 2) + '\n');
            fs.renameSync(file + '.tmp', file);
            const notified = askOf(json) && askOf(json) !== prevAsk ? notifyAsk(root, id, askOf(json)) : null;
            try { answerHook(root, id); } catch (e) { console.error('answer hook:', e.message || e); }
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
        // 🎤 누르는 순간 모델을 미리 올린다 — 다른 맥이 받을 수 있으면 이 맥 모델은 올리지 않는다
        if (st.ready && url.searchParams.get('warm') === '1') sttRemoteReady().then(ok => ok || sttServer()).catch(() => {});
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
    if (url.pathname === '/api/asks' && req.method === 'GET') {   // ?d=<시트> → 그 시트의 문항 질문과 답
      const name = url.searchParams.get('d') || '';
      if (!ID_RE.test(name)) return send(res, 400, 'text/plain', 'd=<sheet> ([a-z0-9-])');
      return send(res, 200, TYPES['.json'], JSON.stringify(asksFor(root, name)));
    }
    if (url.pathname === '/__ask') {   // POST ?d=<시트> {q,label,text} — 페이지(hero) 전용, CORS 없음, 제출과 무관
      const name = url.searchParams.get('d') || '';
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST');
      if (!ID_RE.test(name)) return send(res, 400, 'text/plain', 'd=<sheet> ([a-z0-9-])');
      if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return send(res, 415, 'text/plain', 'application/json');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e4) req.destroy(); });
      req.on('end', () => {
        try { const j = JSON.parse(body || '{}'); send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, ...askItem(root, name, j.q, j.label, j.text) })); }
        catch (e) { send(res, 400, 'text/plain; charset=utf-8', String(e.message || e)); }
      });
      return;
    }
    if (url.pathname === '/api/push' && req.method === 'GET') return send(res, 200, TYPES['.json'], JSON.stringify({ publicKey: vapidKeys(root).publicKey, subs: readSubs(root).length }));
    if (/^\/__push\/(sub|unsub|test)$/.test(url.pathname)) {   // 폰 알림 구독 — 페이지(hero) 전용, CORS 없음
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST');
      if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return send(res, 415, 'text/plain', 'application/json');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', async () => {
        try {
          const j = JSON.parse(body || '{}'), op = url.pathname.slice(8);
          if (op === 'sub') return send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, subs: addSub(root, j.subscription, { origin: req.headers.origin || '', ua: req.headers['user-agent'] || '' }) }));
          if (op === 'unsub') return send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, subs: removeSub(root, String(j.endpoint || '')) }));
          send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, sent: await pushAll(root, { title: '🔔 리뷰시트 알림 시험', body: '이 알림이 보이면 켜진 거예요.', url: '/', tag: 'test' }) }));
        } catch (e) { send(res, 400, 'text/plain; charset=utf-8', String(e.message || e)); }
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
    if (url.pathname === '/dash') return serveFile(res, path.join(WEB, 'dash.html'));
    if (url.pathname === '/api/dash') return send(res, 200, TYPES['.json'], JSON.stringify({ dash: readDash(root) }), cors);
    if (url.pathname === '/batch') return serveFile(res, path.join(WEB, 'batch.html'));
    if (url.pathname === '/api/batch') { const bs = readBatches(root); return send(res, 200, TYPES['.json'], JSON.stringify({ batches: bs.map(b => ({ ...b, chat: batchChat(root, b.domain) })) }), cors); }
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
          const kind = typeof j.kind === 'string' && Object.hasOwn(CHAT_KINDS, j.kind) ? j.kind : undefined;   // 모르는 값 → 평문
          if (text || files.length) msg = appendChat(root, ch, 'hero', text, files, re,
            kind || j.auto === true ? { ...(kind ? { kind } : {}), ...(j.auto === true ? { auto: true } : {}) } : undefined);   // 자동 게시자는 auto=true; 페이지 글은 hero
          const meta = markSeen(root, ch, 'hero');
          send(res, 200, TYPES['.json'], JSON.stringify({ ok: true, msg, meta }));
        } catch (e) { send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + (e.message || e)); }
      });
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '/index.html') return send(res, 200, TYPES['.html'], indexHtml(root));
    if (['/sheet.html', '/sheet.css', '/chat.html', '/memo.html', '/board.html', '/dash.html', '/batch.html', '/mic.js', '/compose.js', '/push.js', '/keys.js', '/sw.js', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png'].includes(rel)) return serveFile(res, path.join(WEB, rel.slice(1)));
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) return send(res, 403, 'text/plain', 'forbidden');
    serveFile(res, file);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      const stop = pushWatch(root), stopAsk = askWatch(root);
      resolve({ port: p, base: `http://127.0.0.1:${p}`, close: () => { stop(); stopAsk(); return new Promise(r => server.close(r)); } });
    });
  });
}

function lanAddrs() {
  try {
    return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  } catch { return []; }
}

function launchdPlist(port, lan) {
  // --use-bundled-ca: brew node(openssl@4) 기본 인증서 저장소로는 web.push.apple.com 체인 검증 실패(UNABLE_TO_GET_ISSUER_CERT_LOCALLY) — 폰 알림이 안 갔음 (hero 2026-10-18)
  const args = [process.execPath, '--use-bundled-ca', fileURLToPath(import.meta.url), 'serve', INBOX, '--port', String(port)].concat(lan ? ['--lan'] : []);
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
  let askArgs = rest.slice(2);   // asks / ask-reply / items / record: [dir] 은 진짜 폴더일 때만
  if ((cmd === 'board' || cmd === 'dash' || cmd === 'batch' || cmd === 'links') && rest.length === 2 && !(fs.existsSync(rest[1]) && fs.statSync(rest[1]).isDirectory())) dirArg = undefined;   // board <file|-> → inbox, board <dir> → 요약
  if (['asks', 'ask-reply', 'items', 'record', 'migrate-assign'].includes(cmd) && !(rest[1] && fs.existsSync(rest[1]) && fs.statSync(rest[1]).isDirectory())) { dirArg = undefined; askArgs = rest.slice(1); }
  const dir = path.resolve(dirArg || INBOX);
  const isInbox = !dirArg;
  if (isInbox && cmd !== 'serve') fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });

  if (cmd === 'wait-any') {
    if (rest.length !== 2 || !ID_RE.test(rest[1])) usage();
    await waitAny(INBOX, rest[1], flags); return;
  }

  if (cmd === 'chat') {
    const [, sub, ch, ...words] = rest;
    const root = INBOX; fs.mkdirSync(chatDir(root), { recursive: true });
    const fmt = m => formatChat(root, ch, m);
    if (sub === 'hub') { if (!ch) { const h = hubChat(root); console.log(h ? h.name : '(허브 없음 — chat hub <ch>)'); return; } setHub(root, ch); console.log(`허브 = ${ch}  → http://127.0.0.1:${INBOX_PORT}/hub`); return; }
    if (sub === 'new') { const m = newChat(root, ch, flags.title, flags.owner, flags.hub || !listChats(root).length); console.log(`${chatLogFile(root, m.name)}\n  → http://127.0.0.1:${INBOX_PORT}/chat.html?c=${m.name}`); return; }
    if (sub === 'ls') { for (const c of listChats(root)) console.log(`${c.hub ? '★' : ''}${c.name}\t${c.owner}\t${c.count}건\thero 미읽 ${c.unreadHero}\t세션 미읽 ${c.unreadOwner}\t${c.title}`); return; }
    if (!ch || !readChatMeta(root, ch)) { console.error(`채널 ${ch || '?'} 없음 — chat new <ch>`); process.exit(1); }
    if (sub === 'pin' || sub === 'unpin') {   // 방 맨 위 고정 글 하나(hero 2026-10-19 #55) — 상시로 펼쳐 볼 주소·안내. 채팅 게이트 밖(링크가 본 용도)
      const meta = readChatMeta(root, ch);
      if (sub === 'unpin') { delete meta.pin; writeChatMeta(root, meta); console.log(`${ch} 고정 해제`); return; }
      const text = words[0] === '-' || !words.length ? fs.readFileSync(0, 'utf8').trim() : words.join(' ');
      if (!text) { console.error('text 없음'); process.exit(2); }
      meta.pin = { text, at: new Date().toISOString() }; writeChatMeta(root, meta); console.log(`${ch} 고정: ${text}`); return;
    }
    if (sub === 'say') {
      const text = words[0] === '-' || !words.length ? fs.readFileSync(0, 'utf8').trim() : words.join(' ');
      if (!text) { console.error('text 없음'); process.exit(2); }
      const heroReply = !!flags.re && readChatLog(root, ch).some(m => m.id === flags.re && m.from === 'hero');
      const why = flags.notice ? null : chatGate(text, { heroReply });
      if (why) { console.error(`보내지 않음 — ${why}. hero 가 보고 맞는지 정할 것(결과물·링크·질문)은 시트로: review-sheet new <이름>\n받음·담당·머지/배포 한 줄처럼 꼭 채팅이어야 하는 알림이면 --notice 를 붙여 다시 보낸다.`); process.exit(6); }
      const meta = readChatMeta(root, ch); const m = appendChat(root, ch, meta.owner, text, undefined, flags.re);   // 읽음은 read/wait 만 — 보내는 순간 막 온 hero 글까지 읽음 처리돼 놓쳤다(hero 2026-10-16)
      console.log(fmt(m)); return;
    }
    if (sub === 'read' || sub === 'wait') {
      const fresh = () => {
        if (sub === 'wait') return freshHero(root, ch);
        return unseenHero(root, ch, m => m.from === 'hero');
      };
      let msgs = flags.all ? readChatLog(root, ch) : fresh();
      if (sub === 'wait' && !msgs.length) {
        const deadline = Date.now() + (flags.timeout || 3600) * 1000;
        console.error(`waiting for hero on #${ch} (timeout ${flags.timeout || 3600}s)…`);
        while (Date.now() < deadline) { await new Promise(r => setTimeout(r, 2000)); msgs = fresh(); if (msgs.length) break; }
        if (!msgs.length) { console.error('timeout'); process.exit(3); }
      }
      if (flags.json) await writeOutput(JSON.stringify(msgs, null, 2) + '\n');
      else if (msgs.length) await writeOutput(msgs.map(fmt).join('\n') + '\n');
      if (!flags.all) markSeen(root, ch, 'owner', msgs);
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
    const iSince = fs.existsSync(path.join(assignDir(dir), '.items-since')) ? itemsSince(dir) : '9';
    const tag = (s, st) => st && STATE_LABEL[st] ? '\t' + STATE_LABEL[st] : s.assign ? `\t${s.assign.stage}${st === 'closed' ? '(이슈닫힘)' : ''} ${s.assign.issue}` : '';
    for (const s of listSheets(dir)) console.log(s.error ? `${s.name}\tERROR ${s.error}` : `${s.urgent ? '🔥' : ''}${s.name}\t${s.id}\t${s.submitted ? '제출됨' : '대기'}\t${s.picked}/${s.total}\t${s.savedAt || '-'}\t${s.title}${tag(s, assignState(dir, s, since, iSince))}`);
    return;
  }
  if (cmd === 'assign') {
    const [id, issue, owner] = rest.slice(isInbox ? 1 : 2);
    if (!id || !issue || !owner) usage();
    const s = listSheets(dir).find(x => !x.error && (x.name === id || x.id === id));
    if (!s) { console.error(`${dir} 에 ${id} 시트 없음`); process.exit(1); }
    if (!s.submitted) { console.error(`${s.name}: 아직 제출 안 됨 — 답이 온 뒤에 배정한다`); process.exit(1); }
    let a; try { a = writeAssign(dir, s.id, issue, owner, undefined, { repo: flags.repo }); } catch (e) { console.error(e.message); process.exit(1); }
    console.log(`${s.name}\t배정 ${a.issue} → ${a.owner}${a.repo ? ' (' + a.repo + ')' : ''}`);
    const left = itemsOpen(dir, s.id).open; if (left.length) console.log(`  문항 장부: ${left.length}개 남음 — items ${s.name} <문항> done --pr N | done --rule "<근거>" | defer --issue N | reject | moved <시트>  (${left.map(x => x.k).join(' ')})`);
    return;
  }
  if (cmd === 'stage') {
    const [id, stage, ...words] = rest.slice(isInbox ? 1 : 2);
    if (!id || !stage) usage();
    const s = listSheets(dir).find(x => !x.error && (x.name === id || x.id === id));
    if (!s) { console.error(`${dir} 에 ${id} 시트 없음`); process.exit(1); }
    try { const a = writeStage(dir, s.id, stage, words.join(' '), undefined, { off: flags.off, offReason: flags.offReason, eta: flags.eta, pr: flags.pr, sha: flags.sha, repo: flags.repo }); console.log(`${s.name}\t${stageTag(a.stages.at(-1))}${words.length ? ' — ' + words.join(' ') : ''}`); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  if (cmd === 'dash') {
    const src = rest.at(-1);
    if (rest.length < 2 || (dirArg && rest.length === 2)) { const d = readDash(dir); if (!d) { console.error('자원판 없음'); process.exit(1); } console.log(`cards\t${d.cards.length}\nrows\t${d.groups.reduce((n, g) => n + g.rows.length, 0)}\nupdatedAt\t${d.updatedAt}`); return; }
    let j; try { j = JSON.parse(src === '-' ? await (async () => { let t = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) t += c; return t; })() : fs.readFileSync(src, 'utf8')); } catch (e) { console.error('dash: JSON 읽기 실패 — ' + e.message); process.exit(1); }
    try { const d = writeDash(dir, j); console.log(`${dashFile(dir)}\t카드 ${d.cards.length}\t→ http://127.0.0.1:${INBOX_PORT}/dash`); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  if (cmd === 'tab') {   // tab [dir] [--prefix X] [--icon Y] [--clear] — 탭 이름표 tab.json 쓰기/보기
    const f = tabFile(dir);
    if (flags.clear) { fs.rmSync(f, { force: true }); console.log(`${f}\t지움`); return; }
    if ('prefix' in flags || 'icon' in flags) {
      const j = readTabFile(dir);
      for (const k of ['prefix', 'icon']) if (k in flags) { const v = flags[k].trim(); if (v) j[k] = v; else delete j[k]; }
      if (j.icon && graphemes(j.icon) > TAB_ICON_MAX) { console.error(`tab: --icon 은 이모지 하나 또는 ${TAB_ICON_MAX}글자까지`); process.exit(1); }
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    }
    const t = tabConfig(dir), j = readTabFile(dir);
    console.log(`${f}\t${JSON.stringify(j)}\nprefix\t${t.prefix || '—'}${process.env.REVIEW_SHEET_TAB_PREFIX ? ' (env)' : ''}\nicon\t${t.icon || '—'}${process.env.REVIEW_SHEET_TAB_ICON ? ' (env)' : ''}`);
    return;
  }
  if (cmd === 'links') {
    const src = rest.at(-1);
    if (rest.length < 2 || (dirArg && rest.length === 2)) { for (const l of readLinks(dir)) console.log(`${l.label}\t${l.url}`); return; }
    let j; try { j = JSON.parse(src === '-' ? await (async () => { let t = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) t += c; return t; })() : fs.readFileSync(src, 'utf8')); } catch (e) { console.error('links: JSON 읽기 실패 — ' + e.message); process.exit(1); }
    try { const ls = writeLinks(dir, j); console.log(`${linksFile(dir)}\t링크 ${ls.length}`); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  if (cmd === 'batch') {
    const src = rest.at(-1);
    if (rest.length < 2 || (dirArg && rest.length === 2)) { const bs = readBatches(dir); if (!bs.length) { console.error('배치판 없음'); process.exit(1); } for (const b of bs) console.log(`${b.domain}\t규칙 ${b.rules.length}\t실행 ${b.rules.reduce((n, r) => n + r.runs.length, 0)}\t${b.at}`); return; }
    let j; try { j = JSON.parse(src === '-' ? await (async () => { let t = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) t += c; return t; })() : fs.readFileSync(src, 'utf8')); } catch (e) { console.error('batch: JSON 읽기 실패 — ' + e.message); process.exit(1); }
    try { const b = writeBatch(dir, j, flags.domain); console.log(`${batchFile(dir, b.domain)}\t규칙 ${b.rules.length}\t실행 ${b.rules.reduce((n, r) => n + r.runs.length, 0)}\t→ http://127.0.0.1:${INBOX_PORT}/batch`); }
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
  if (cmd === 'asks') {   // asks [<시트>] [--open] — 문항 질문과 답. 시트 없으면 전체(--prefix 로 좁힘)
    const names = askArgs[0] ? [askArgs[0]] : listSheets(dir).filter(s => !s.error && (!flags.prefix || String(s.name).startsWith(flags.prefix))).map(s => s.name);
    for (const n of names) for (const a of asksFor(dir, n)) {
      if (flags.open && a.replies.length) continue;
      console.log(`${n}\t${a.q}\t#${a.id}\t${a.replies.length ? '답 ' + a.replies.length : '답 없음'}\t${a.text.replace(/\s+/g, ' ')}`);
    }
    return;
  }
  if (cmd === 'ask-reply') {   // ask-reply <시트> <문항> "답" — 그 문항 질문에 ↩ 답장. 시트 그 문항 밑에 바로 뜬다
    const [name, q, ...t] = askArgs; const text = t.join(' ').trim();
    if (!name || !q || !text) { console.error('ask-reply <시트> <문항> "답"'); process.exit(2); }
    const gate = !flags.notice && chatGate(text, { heroReply: true }); if (gate) { console.error(gate + " — 꼭 필요하면 --notice"); process.exit(2); }
    try { const r = askReply(dir, name, q, text); console.log(`#${r.msg.id} → ${r.ch} ↩#${r.re}`); } catch (e) { console.error(e.message); process.exit(1); }
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
  if (cmd === 'items') {   // items <시트> [<문항> done --pr N | done --rule <근거> | defer --issue N | reject [이유] | moved <시트>] — 문항 장부(#40)
    const [name, key, kind, ...words] = askArgs;
    const s = name && listSheets(dir).find(x => !x.error && (x.name === name || x.id === name));
    if (!s) { console.error(`${dir} 에 ${name || '?'} 시트 없음`); process.exit(name ? 1 : 2); }
    if (key) {
      const opt = { pr: flags.pr, rule: flags.rule, issue: flags.issue, repo: flags.repo, to: kind === 'moved' ? words[0] : '', note: (kind === 'moved' ? words.slice(1) : words).join(' ') };
      try { const r = writeItem(dir, s.id, key, kind, opt); console.log(`${s.name}\t${key}\t${kind}${r.rec.pr ? ' ' + r.rec.pr : r.rec.rule ? ' 규칙: ' + r.rec.rule : r.rec.issue ? ' ' + r.rec.issue : r.rec.to ? ' → ' + r.rec.to : ''}\t남음 ${r.open.length}/${r.keys.length}`); }
      catch (e) { console.error(e.message); process.exit(1); }
      return;
    }
    const a = readAssign(dir, s.id), { keys, open } = itemsOpen(dir, s.id, a), why = Object.fromEntries(open.map(x => [x.k, x.why]));
    const it = (a && a.items) || {};
    for (const k of keys) { const x = it[k]; console.log(`${k}\t${why[k] ? { missing: '안 붙음', changed: '답 바뀜', reverted: '되돌려짐' }[why[k]] : 'ok'}${x ? `\t${x.kind}${x.pr ? ' ' + x.pr : x.rule ? ' 규칙: ' + x.rule : x.issue ? ' ' + x.issue : x.to ? ' → ' + x.to : ''}${x.note ? ' — ' + x.note : ''}` : ''}`); }
    if (open.length) process.exitCode = 5;
    return;
  }
  if (cmd === 'record') {   // record <시트> [--issue N] — read 출력 전체를 이슈 댓글로, 다시 부르면 바뀐 줄만(#40)
    const [name] = askArgs; if (!name) usage();
    try { const r = recordSheet(dir, name, { issue: flags.issue, repo: flags.repo }); console.log(r.posted ? `${name}\t→ ${r.key}\t${r.fresh}줄${r.url ? '\t' + r.url : ''}` : `${name}\t→ ${r.key}\t바뀐 것 없음`); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  if (cmd === 'migrate-assign') {   // 옛 뒤바뀐 assign 맞바꾸기 — --dry-run 이면 건수만
    const r = migrateAssign(dir, { dryRun: !!flags['dry-run'] });
    for (const x of r.fixed) console.log(`${x.id}\t${x.was[0]} ${x.was[1]}\t→ ${x.issue} ${x.owner}`);
    console.log(`${flags['dry-run'] ? '고칠 것' : '고침'} ${r.fixed.length} / 배정 ${r.total}${r.backup ? `\t백업 ${r.backup}` : ''}`);
    return;
  }
  if (cmd === 'unassigned') {   // 문항 안 붙음·되돌림·이슈 닫혔는데 단계 덜 됨만 (#40 — 예전 24h '멈춤'은 소음이라 뺐다)
    const since = assignSince(dir), iSince = itemsSince(dir), open = [];
    const warn = new Set(), onError = e => warn.add(e.message);
    checkReverts(dir, { onError }); checkIssues(dir, { onError });
    for (const s of listSheets(dir)) {
      if (flags.prefix && !String(s.name).startsWith(flags.prefix)) continue;
      const st = assignState(dir, s, since, iSince);
      if (st === 'none' || st === 'changed') open.push(`${s.name}\t${STATE_LABEL[st]}\t${s.savedAt}\t${s.from || '-'}\t${s.title}${s.partial ? ` · 부분제출(미선택 ${s.partial})` : ''}`);
      if (st === 'items') { const o = itemsOpen(dir, s.id).open; open.push(`${s.name}\t문항안붙음\t${s.savedAt}\t${s.assign.owner}\t${s.title} (${o.map(x => x.k + (x.why === 'missing' ? '' : '·' + { changed: '답바뀜', reverted: '되돌림' }[x.why])).join(' ')})`); }
      if (st === 'reverted') open.push(`${s.name}\t되돌림\t${s.assign.stageAt}\t${s.assign.owner}\t${s.title} (${s.assign.note} · ${s.assign.issue})`);
      if (st === 'closed') open.push(`${s.name}\t이슈닫힘\t${s.assign.stageAt}\t${s.assign.owner}\t${s.title} (${s.assign.stage} ${s.assign.issue} — 이슈는 닫혔는데 라이브·끝 아님)`);
    }
    for (const l of open) console.log(l);
    for (const w of warn) console.error('gh 확인 못 함: ' + w);
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
