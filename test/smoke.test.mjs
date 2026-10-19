// node --test review-sheet/test/   — server round-trip + read/markdown. No deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, loadSheet, readAnswers, renderMarkdown, dropHallucination, stageTag } from '../bin/review-sheet.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'review-sheet.mjs');
const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'example-data.js');

/* gh 스텁 (#40) — `gh api <path> [--input -]` 를 fixtures { path: 응답 | { $err } } 로 답하고, 부른 것을 log 에 남긴다.
   path 는 gh 가 채우기 전 그대로({owner}/{repo}) — repos/o/r/… 로 와도 같은 것으로 본다. 'search/issues' 처럼 ? 앞까지만 맞춰도 된다. --input 이면 stdin 을 log 에. */
function ghStub(fixtures) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  const fx = path.join(d, 'fx.json'), log = path.join(d, 'log.jsonl'), bin = path.join(d, 'gh');
  fs.writeFileSync(fx, JSON.stringify(fixtures));
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const p = a[1];
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fx)}, 'utf8'));
let input = ''; if (a.includes('--input')) input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, input }) + '\\n');
const q = p.replace('repos/o/r/', 'repos/{owner}/{repo}/'), r = [p, q, p.split('?')[0]].map(k => fx[k]).find(x => x !== undefined);   // o/r = 스텁의 기본 레포
if (r === undefined || (r && r.$err)) { process.stderr.write('HTTP 404: ' + (r && r.$err || 'Not Found') + ' (stub ' + p + ')\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(r));
`);
  fs.chmodSync(bin, 0o755);
  const set = f => fs.writeFileSync(fx, JSON.stringify(f));
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { env: { ...process.env, REVIEW_SHEET_GH: bin, REVIEW_SHEET_FROM: 'proj:ws9' }, set, calls, fixtures };
}
const R = 'repos/{owner}/{repo}';
const ghIssueFx = (n, extra) => ({ number: n, state: 'open', html_url: `https://github.com/o/r/issues/${n}`, ...extra });
const ghPrFx = (n, merged, extra) => ({ number: n, merged, state: merged ? 'closed' : 'open', title: 'T' + n, html_url: `https://github.com/o/r/pull/${n}`,
  merge_commit_sha: merged ? 'm' + String(n).padStart(6, '0') + 'aaaa' : null, merged_at: merged ? new Date().toISOString() : null, base: { repo: { full_name: 'o/r' } }, ...extra });
const runIn = env => (...a) => { try { return { out: execFileSync('node', [BIN, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; } catch (e) { return { out: e.stdout + e.stderr, code: e.status }; } };

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sheet-'));
  fs.copyFileSync(TEMPLATE, path.join(dir, 'example-data.js'));
  return dir;
}

test('template loads and renders without answers', () => {
  const dir = tmpDir();
  const sheet = loadSheet(dir, 'example');
  assert.equal(sheet.id, 'example');
  const md = renderMarkdown(sheet, null);
  assert.match(md, /아직 저장된 답변 없음/);
  assert.match(md, /\| 1 \| 질문 한 줄 \| — \|/);
});

test('serve: page, data, POST → file, GET → same, index lists the sheet', async () => {
  const dir = tmpDir();
  const { base, close } = await startServer(dir, 0);
  try {
    assert.equal((await fetch(base + '/sheet.html?d=example')).status, 200);
    assert.equal((await fetch(base + '/sheet.css')).status, 200);
    assert.equal((await fetch(base + '/example-data.js')).status, 200);
    assert.equal((await fetch(base + '/../etc/passwd')).status, 404);
    const empty = await (await fetch(base + '/__answers?sheet=example')).json();
    assert.deepEqual(empty, {});
    const body = { sheet: 'example', answers: { 'A-1': { pick: '① 선택지 하나' }, 'A-2': { memo: '둘 다 싫다' } } };
    const r = await fetch(base + '/__answers?sheet=example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    const saved = readAnswers(dir, 'example');
    assert.equal(saved.answers['A-1'].pick, '① 선택지 하나');
    assert.ok(saved.savedAt);
    const back = await (await fetch(base + '/__answers?sheet=example')).json();
    assert.equal(back.savedAt, saved.savedAt);
    assert.equal((await fetch(base + '/__answers?sheet=../x')).status, 400);
    assert.equal((await fetch(base + '/__answers?sheet=example', { method: 'POST', body: 'nope' })).status, 400);
    const blank = await fetch(base + '/__answers?sheet=example', { method: 'POST', body: JSON.stringify({ answers: {} }) });   // 빈 제출 (#43)
    assert.equal(blank.status, 400);
    assert.equal((await fetch(base + '/__answers?sheet=example', { method: 'POST', body: JSON.stringify({ answers: { 'A-1': { memo: '  ' } } }) })).status, 400);
    assert.equal(readAnswers(dir, 'example').savedAt, saved.savedAt);   // 기존 답 그대로
    assert.equal((await fetch(base + '/__answers?sheet=never', { method: 'POST', body: JSON.stringify({ answers: {} }) })).status, 400);
    assert.ok(!fs.existsSync(path.join(dir, 'answers', 'never.json')));
    const index = await (await fetch(base + '/')).text();
    assert.match(index, /"name":"example"[^}]*"picked":2[^}]*"submitted":true/);
    const api = await (await fetch(base + '/api/sheets')).json();
    assert.equal(api.sheets[0].submitted, true); assert.equal(api.sheets[0].picked, 2);
  } finally { await close(); }
});

test('cli: read prints the picks as markdown, ls shows progress, new copies the template', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: '2026-01-01T00:00:00.000Z',
    answers: { 'A-1': { pick: '② 선택지 둘', memo: '이유' }, 'A-memo': { memo: '전체 메모' } } }));
  const md = execFileSync('node', [BIN, 'read', dir, 'example'], { encoding: 'utf8' });
  assert.match(md, /\| 1 \| 질문 한 줄 \| ② 선택지 둘 \| 이유 \|/);
  assert.match(md, /\| 2 \| 두 번째 질문 \| — \|  \|/);
  assert.match(md, /> 전체 메모: 전체 메모/);
  assert.match(md, /1\/2 선택됨/);
  const json = JSON.parse(execFileSync('node', [BIN, 'read', dir, 'example', '--json'], { encoding: 'utf8' }));
  assert.equal(json.answers['A-1'].pick, '② 선택지 둘');
  const ls = execFileSync('node', [BIN, 'ls', dir], { encoding: 'utf8' });
  assert.match(ls, /^example\texample\t제출됨\t1\/2\t2026-01-01/);
  const created = execFileSync('node', [BIN, 'new', dir, 'second'], { encoding: 'utf8' }).trim();
  assert.ok(created.endsWith('second-data.js'));
  assert.equal(loadSheet(dir, 'second').id, 'second');
});

test('wait: returns when the answers file is saved', async () => {
  const dir = tmpDir();
  const { base, close } = await startServer(dir, 0);
  try {
    const { spawn } = await import('node:child_process');
    const p = spawn('node', [BIN, 'wait', dir, 'example', '--timeout', '20'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', c => { out += c; });
    await new Promise(r => setTimeout(r, 2500));
    await fetch(base + '/__answers?sheet=example', { method: 'POST', body: JSON.stringify({ sheet: 'example', answers: { 'A-1': { pick: '① 선택지 하나' } } }) });
    const code = await new Promise(r => p.on('exit', r));
    assert.equal(code, 0);
    assert.match(out, /① 선택지 하나/);
  } finally { await close(); }
});

test('chat: new → page posts as hero → owner reads/says → hero sees 읽음 + unread counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-chat-'));
  const { newChat, listChats, appendChat, readChatLog, chatGate } = await import('../bin/review-sheet.mjs');
  newChat(dir, 'root', 'root 와 대화', 'root:hub');
  const { base, close } = await startServer(dir, 0);
  try {
    // hero writes from the page
    let r = await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '안녕' }) });
    assert.equal(r.status, 200);
    let c = listChats(dir)[0];
    assert.equal(c.unreadOwner, 1); assert.equal(c.unreadHero, 0);
    // owner side via CLI: wait returns immediately with the unread hero message and marks seen
    const env = { ...process.env, REVIEW_SHEET_INBOX: dir };
    const out = execFileSync('node', [BIN, 'chat', 'wait', 'root', '--timeout', '5'], { encoding: 'utf8', env });
    assert.match(out, /hero: 안녕/);
    assert.equal(listChats(dir)[0].unreadOwner, 0);
    execFileSync('node', [BIN, 'chat', 'say', 'root', '답장이다'], { encoding: 'utf8', env });
    // review material is refused in chat (exit 6) unless --notice
    assert.throws(() => execFileSync('node', [BIN, 'chat', 'say', 'root', '주둔지 POC http://x:1/p — 재밌는지 말씀 주세요'], { encoding: 'utf8', env, stdio: 'pipe' }), e => e.status === 6 && /시트로/.test(String(e.stderr)));
    assert.throws(() => execFileSync('node', [BIN, 'chat', 'say', 'root', '가'.repeat(501)], { encoding: 'utf8', env, stdio: 'pipe' }), e => e.status === 6);
    // hero 메시지에 다는 답장은 2000자까지(물은 걸 다 답하게, hero 2026-10-15) — 링크 막기는 그대로
    assert.equal(chatGate('가'.repeat(1500), { heroReply: true }), null);
    assert.match(chatGate('가'.repeat(2001), { heroReply: true }), /나눠/);
    assert.match(chatGate('가'.repeat(501)), /--re/);
    assert.match(chatGate('http://x:1/p 참고', { heroReply: true }), /링크/);
    assert.equal(chatGate('받음 — #2156 버그 창에 맡김'), null);
    assert.match(chatGate('평가 끝났어요, 괜찮은지 봐 주세요'), /요청/);
    execFileSync('node', [BIN, 'chat', 'say', 'root', '--notice', '머지됨 http://x/pr/1'], { encoding: 'utf8', env });
    assert.equal(readChatLog(dir, 'root').filter(m => m.from === 'root:hub').length, 2);
    c = listChats(dir)[0];
    assert.equal(c.unreadHero, 2); assert.equal(c.last.from, 'root:hub');
    // page: api shows seenAt ≥ hero message ts (읽음), and hero viewing clears unreadHero
    const j = await (await fetch(base + '/api/chat?c=root')).json();
    assert.ok(j.meta.seenAt >= j.messages[0].ts); assert.equal(j.messages.length, 3);
    await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(listChats(dir)[0].unreadHero, 0);
    // unknown channel → 404, bad id → 400/404
    assert.equal((await fetch(base + '/api/chat?c=nope')).status, 404);
    assert.equal((await fetch(base + '/__chat?c=..', { method: 'POST', body: '{}' })).status, 404);
    // ls via CLI + chat.html served
    assert.match(execFileSync('node', [BIN, 'chat', 'ls'], { encoding: 'utf8', env }), /^root\troot:hub\t3건/);
    assert.equal((await fetch(base + '/chat.html?c=root')).status, 200);
    assert.ok(readChatLog(dir, 'root').length === 3 && appendChat);
    // image attach: upload raw → name → message files; non-image rejected; CLI prints the absolute path
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    assert.equal((await fetch(base + '/__chat/file?c=root', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 400);
    const { name } = await (await fetch(base + '/__chat/file?c=root', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json();
    r = await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '', files: [name, '../root.json'] }) });
    assert.deepEqual((await r.json()).msg.files, [name]);
    assert.equal((await fetch(base + '/chat/root.files/' + name)).headers.get('content-type'), 'image/png');
    assert.match(execFileSync('node', [BIN, 'chat', 'read', 'root'], { encoding: 'utf8', env }), new RegExp('\\[이미지\\] .*root\\.files/' + name));
  } finally { await close(); }
});

test('chat reply (hero 2026-10-09): say --re quotes an earlier message, page may post re, unknown original is dropped/rejected, read prints #id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-reply-'));
  const { newChat, readChatLog } = await import('../bin/review-sheet.mjs');
  newChat(dir, 'root', 'root', 'root:hub');
  const { base, close } = await startServer(dir, 0);
  const env = { ...process.env, REVIEW_SHEET_INBOX: dir };
  try {
    await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '요구 1' }) });
    await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '요구 2' }) });
    const [m1, m2] = readChatLog(dir, 'root');
    // session answers requirement 1 by id; read/wait output carries #id so the session can pick one
    const out = execFileSync('node', [BIN, 'chat', 'read', 'root'], { encoding: 'utf8', env });
    assert.match(out, new RegExp('^#' + m1.id + ' .*hero: 요구 1', 'm'));
    execFileSync('node', [BIN, 'chat', 'say', 'root', '--re', m1.id, '1번 답'], { encoding: 'utf8', env });
    let log = readChatLog(dir, 'root');
    assert.equal(log[2].re, m1.id); assert.equal(log[2].text, '1번 답');
    assert.match(execFileSync('node', [BIN, 'chat', 'read', 'root', '--all'], { encoding: 'utf8', env }), new RegExp('root:hub: ↩#' + m1.id + ' 1번 답'));
    // hero 메시지에 다는 긴 답장(700자)은 통과, 세션 자기 글에 단 답장·평문은 500자 그대로(hero 2026-10-15)
    execFileSync('node', [BIN, 'chat', 'say', 'root', '--re', m2.id, '가'.repeat(700)], { encoding: 'utf8', env });
    assert.equal(readChatLog(dir, 'root').at(-1).text.length, 700);
    assert.throws(() => execFileSync('node', [BIN, 'chat', 'say', 'root', '--re', log[2].id, '가'.repeat(700)], { encoding: 'utf8', env, stdio: 'pipe' }), e => e.status === 6);
    fs.writeFileSync(path.join(dir, 'chat', 'root.jsonl'), readChatLog(dir, 'root').slice(0, 3).map(m => JSON.stringify(m) + '\n').join(''));
    // unknown original → CLI refuses, nothing stored
    assert.throws(() => execFileSync('node', [BIN, 'chat', 'say', 'root', '--re', 'zzzzzzzz', 'x'], { encoding: 'utf8', env, stdio: 'pipe' }), /답장 원문/);
    assert.equal(readChatLog(dir, 'root').length, 3);
    // page: hero replies to the session's answer; a bogus re is dropped, the message still lands
    let r = await (await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '고마워', re: log[2].id }) })).json();
    assert.equal(r.msg.re, log[2].id);
    r = await (await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '평문', re: '../x' }) })).json();
    assert.equal(r.msg.re, undefined); assert.equal(r.msg.text, '평문');
    log = readChatLog(dir, 'root'); assert.equal(log.length, 5); assert.equal(log[1].id, m2.id);
    // api hands re through untouched so the page can quote + jump
    const j = await (await fetch(base + '/api/chat?c=root')).json();
    assert.equal(j.messages[2].re, m1.id);
    assert.match(await (await fetch(base + '/chat.html?c=root')).text(), /c-quote/);
  } finally { await close(); }
});

test('chat kind (hero 2026-10-18): page posts kind → stored, unknown kind dropped, read prints [태그] + 할 일 줄, --json carries kind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-kind-'));
  const { newChat, readChatLog } = await import('../bin/review-sheet.mjs');
  newChat(dir, 'root', 'root', 'root:hub');
  const { base, close } = await startServer(dir, 0);
  const env = { ...process.env, REVIEW_SHEET_INBOX: dir };
  const post = body => fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    let r = await post({ text: '로그인 느림', kind: 'issue' }); assert.equal(r.msg.kind, 'issue');
    r = await post({ text: '저장 버튼 안 눌림', kind: 'bug' }); assert.equal(r.msg.kind, 'bug');
    r = await post({ text: '어제 그거 어떻게 됐어', kind: 'followup', re: r.msg.id }); assert.equal(r.msg.kind, 'followup'); assert.ok(r.msg.re);
    r = await post({ text: '평문', kind: 'urgent' }); assert.equal(r.msg.kind, undefined); assert.equal(r.msg.text, '평문');
    r = await post({ text: '평문2', kind: ['issue'] }); assert.equal(r.msg.kind, undefined);
    r = await post({ text: '평문3', kind: '__proto__' }); assert.equal(r.msg.kind, undefined);
    const log = readChatLog(dir, 'root');
    assert.deepEqual(log.map(m => m.kind || null), ['issue', 'bug', 'followup', null, null, null]);
    const out = execFileSync('node', [BIN, 'chat', 'read', 'root'], { encoding: 'utf8', env });
    assert.match(out, new RegExp('^#' + log[0].id + ' .*hero: \\[이슈제기\\] 로그인 느림\\n  — 이슈 제기: .*SoT 이슈', 'm'));
    assert.match(out, /hero: \[버그제보\] 저장 버튼 안 눌림\n  — 버그 제보: bug 라벨/);
    assert.match(out, new RegExp('hero: \\[지난이슈확인\\] ↩#' + log[1].id + ' 어제 그거 어떻게 됐어\\n  — 지난 이슈 확인: '));
    assert.match(out, new RegExp('^#' + log[3].id + ' .*hero: 평문$', 'm'));   // 평문은 지금 그대로 — 태그·할 일 줄 없음
    assert.equal((out.match(/\n  — /g) || []).length, 3);
    const j = JSON.parse(execFileSync('node', [BIN, 'chat', 'read', 'root', '--all', '--json'], { encoding: 'utf8', env }));
    assert.equal(j[0].kind, 'issue'); assert.equal(j[3].kind, undefined);
    const api = await (await fetch(base + '/api/chat?c=root')).json(); assert.equal(api.messages[1].kind, 'bug');
    const html = await (await fetch(base + '/chat.html?c=root')).text();
    assert.match(html, /id="c-adv"/); assert.match(html, /data-kind="followup"/);
  } finally { await close(); }
});

test('hub: first CLI channel becomes the hub, chat hub switches it, /hub redirects, hub listed first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-hub-'));
  const env = { ...process.env, REVIEW_SHEET_INBOX: dir };
  const cli = (...a) => execFileSync('node', [BIN, ...a], { encoding: 'utf8', env });
  cli('chat', 'new', 'main', '--title', '메인 허브', '--owner', 'main');
  cli('chat', 'new', 'proj', '--owner', 'proj:main');
  const { listChats } = await import('../bin/review-sheet.mjs');
  assert.deepEqual(listChats(dir).map(c => [c.name, c.hub]), [['main', true], ['proj', false]]);
  assert.match(cli('chat', 'hub'), /^main/);
  cli('chat', 'hub', 'proj');
  assert.deepEqual(listChats(dir).map(c => [c.name, c.hub]), [['proj', true], ['main', false]]);
  assert.match(cli('chat', 'ls'), /^★proj\t/);
  const { base, close } = await startServer(dir, 0);
  try {
    const r = await fetch(base + '/hub', { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/chat.html?c=proj');
    assert.match(await (await fetch(base + '/')).text(), /메인 허브|★/);
  } finally { await close(); }
});
test('markup: <b>/<br> in text fields render as bold/line break on the page, other tags stay visible text, markdown export gets ** instead of tags (hero 2026-10-05)', () => {
  // The page's e()/m() helpers, lifted out of sheet.html so this runs without a browser.
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'sheet.html'), 'utf8');
  const eLine = src.split('\n').find(l => l.startsWith('const e = ')), mLine = src.split('\n').find(l => l.startsWith('const m = '));
  assert.ok(eLine && mLine, 'sheet.html defines const e and const m');
  const m = new Function(eLine + '\n' + mLine + '\nreturn m;')();
  assert.equal(m('<b>문제</b> 토큰 만료<br><b>한 것</b> 재배포'), '<b>문제</b> 토큰 만료<br><b>한 것</b> 재배포');
  assert.equal(m('줄1\n줄2'), '줄1<br>줄2');
  assert.equal(m('<script>x</script> & <img src=x>'), '&lt;script&gt;x&lt;/script&gt; &amp; &lt;img src=x&gt;');
  // Every text slot goes through m(), not bare e() — the fields hero reads.
  for (const f of ['s.ask', 's.now', 'o.sit', 'o.decide', 'o.effect', 'why', 'lb', 'ex', 't.note']) assert.ok(src.includes('m(' + f + ')'), f + ' rendered with m()');
  // Markdown export: same markup → markdown, no tags leak into the SoT.
  const sheet = { id: 'mk', title: 'mk', sections: [{ code: 'A', title: 'a', questions: [{ k: '1', q: '<b>문제</b> 만료<br>다음 | 줄', opts: [['① 예']], rec: '①' }] }] };
  const md = renderMarkdown(sheet, { savedAt: 'now', answers: { 'A-1': { pick: '① 예' } } });
  assert.match(md, /\| 1 \| \*\*문제\*\* 만료<br>다음 \\\| 줄 \| ① 예 \|/);
  assert.doesNotMatch(md, /<b>/);
});

test('memo: 나와의 메시지 — GET empty → POST sends → delete one → old one-page pad migrates per paragraph → inbox counts, never the text (hero 2026-10-06)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-memo-'));
  const { readMemo, listMemos } = await import('../bin/review-sheet.mjs');
  const { base, close } = await startServer(dir, 0);
  const post = (body, m = 'hero') => fetch(base + '/__memo?m=' + m, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let j = await (await fetch(base + '/api/memo')).json();
    assert.deepEqual(j, { name: 'hero', messages: [] });
    assert.equal(listMemos(dir)[0].name, 'hero');                       // listed before the first message, so hero can find it
    let r = await post({ text: '첫 메시지' }); assert.equal(r.status, 200);
    const m1 = await r.json(); assert.ok(m1.id && m1.ts); assert.equal(m1.text, '첫 메시지');
    const m2 = await (await post({ text: '둘째\n줄바꿈' })).json();
    j = await (await fetch(base + '/api/memo')).json();
    assert.deepEqual(j.messages.map(m => m.text), ['첫 메시지', '둘째\n줄바꿈']);
    assert.equal(fs.readFileSync(path.join(dir, 'memo', 'hero.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);   // one line per message
    // delete one, by id
    r = await post({ del: m1.id }); assert.equal(r.status, 200);
    assert.deepEqual(readMemo(dir, 'hero').messages.map(m => m.id), [m2.id]);
    assert.equal((await post({ del: 'nope' })).status, 404);
    // the inbox gets count + time only — the words stay hero's
    const inbox = await (await fetch(base + '/api/inbox')).json();
    assert.equal(inbox.memos[0].count, 1); assert.equal(inbox.memos[0].lastAt, m2.ts);
    assert.ok(!JSON.stringify(inbox.memos).includes('둘째'));
    // page + guards
    assert.equal((await fetch(base + '/memo.html')).status, 200);
    assert.equal((await fetch(base + '/api/memo?m=..')).status, 400);
    assert.equal((await post({ text: '   ' })).status, 400);
    assert.equal((await post({ nope: 1 })).status, 400);
    // the pre-10-06 autosave pad (one .md) becomes messages, one per blank-line paragraph, in order; the file stays as .md.migrated
    fs.writeFileSync(path.join(dir, 'memo', 'ideas.md'), '- 하나\n둘째 줄\n\n- 둘\n\n\n- 셋\n');
    const ideas = readMemo(dir, 'ideas');
    assert.deepEqual(ideas.messages.map(m => m.text), ['- 하나\n둘째 줄', '- 둘', '- 셋']);
    assert.ok(ideas.messages[0].ts < ideas.messages[2].ts);
    assert.ok(fs.existsSync(path.join(dir, 'memo', 'ideas.md.migrated')) && !fs.existsSync(path.join(dir, 'memo', 'ideas.md')));
    assert.deepEqual(listMemos(dir).map(m => [m.name, m.count]), [['hero', 1], ['ideas', 3]]);
    assert.equal(readMemo(dir, 'ideas').messages.length, 3);           // migration runs once
  } finally { await close(); }
});

test('sheet attach: upload any file → answer keeps {name,orig} → bogus names dropped → images inline, others download → read prints the path (hero 2026-10-06)', async () => {
  const dir = tmpDir(), sheet = loadSheet(dir, 'example');
  const { base, close } = await startServer(dir, 0);
  const up = (n, type, body) => fetch(base + '/__answers/file?sheet=' + sheet.id + '&n=' + encodeURIComponent(n), { method: 'POST', headers: { 'content-type': type }, body });
  try {
    assert.equal((await up('x.png', 'image/png', '')).status, 400);                 // empty
    assert.equal((await fetch(base + '/__answers/file?sheet=../x', { method: 'POST', body: 'a' })).status, 400);
    const png = (await (await up('스샷.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).json()).name;
    const html = (await (await up('page.html', 'text/html', '<script>alert(1)</script>')).json()).name;
    assert.match(png, /^[a-z0-9]+\.png$/); assert.match(html, /^[a-z0-9]+\.html$/);
    const r1 = await fetch(base + '/answers/' + sheet.id + '.files/' + png);
    assert.equal(r1.headers.get('content-type'), 'image/png'); assert.equal(r1.headers.get('content-disposition'), null);
    const r2 = await fetch(base + '/answers/' + sheet.id + '.files/' + html);
    assert.equal(r2.headers.get('content-type'), 'application/octet-stream'); assert.equal(r2.headers.get('content-disposition'), 'attachment');
    const q = sheet.sections[0].code + '-' + sheet.sections[0].questions[0].k;
    const body = { answers: { [q]: { memo: 'm', files: [{ name: png, orig: '스샷.png' }, { name: '../../x.json', orig: 'evil' }, { name: 'zzzzzzzz.png', orig: 'gone' }] }, [sheet.sections[0].code + '-memo']: { files: [{ name: html, orig: 'page.html' }] } } };
    assert.equal((await fetch(base + '/__answers?sheet=' + sheet.id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 200);
    const saved = readAnswers(dir, sheet.id);
    assert.deepEqual(saved.answers[q].files, [{ name: png, orig: '스샷.png' }]);
    const md = renderMarkdown(sheet, saved, dir);
    assert.ok(md.includes('📎 ' + q + ': 스샷.png → ' + path.join(path.resolve(dir), 'answers', sheet.id + '.files', png)), md);
    assert.ok(md.includes('page.html →'));
    assert.match(md, /📎1 \|/);
  } finally { await close(); }
});

test('stt: /api/stt → ffmpeg → whisper-cli with vocab as --prompt (fake binaries, nothing leaves the box)', async () => {
  const dir = tmpDir();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-stt-bin-'));
  const ff = path.join(bin, 'ffmpeg'), wh = path.join(bin, 'whisper-cli'), model = path.join(bin, 'model.bin'), vocab = path.join(bin, 'vocab.txt');
  fs.writeFileSync(ff, '#!/bin/sh\nfor a; do last="$a"; done\nif [ -f "$(dirname "$0")/silent" ]; then printf wav > "$last"; else head -c 16044 /dev/urandom > "$last"; fi\n', { mode: 0o755 });   // ffmpeg … <out.wav> (0.5초 잡음, silent 면 빈 소리)
  fs.writeFileSync(wh, '#!/bin/sh\necho "  안녕하세요 $*"\necho\n', { mode: 0o755 });                       // echoes its args
  fs.writeFileSync(model, 'x');
  fs.writeFileSync(vocab, '# 주석\n스파이더\n\n리뷰시트\n');
  const saved = { ...process.env };
  const { base, close } = await startServer(dir, 0);
  try {
    // not ready → 503 (model missing)
    Object.assign(process.env, { REVIEW_SHEET_WHISPER_BIN: wh, REVIEW_SHEET_FFMPEG: ff, REVIEW_SHEET_WHISPER_MODEL: path.join(bin, 'nope.bin'), REVIEW_SHEET_VOCAB: vocab });
    assert.equal((await (await fetch(base + '/api/stt')).json()).ready, false);
    assert.equal((await fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: 'abc' })).status, 503);
    process.env.REVIEW_SHEET_WHISPER_MODEL = model;
    const st = await (await fetch(base + '/api/stt')).json();
    assert.equal(st.ready, true); assert.equal(st.vocab, 2); assert.equal(st.lang, 'ko');
    // wrong content-type (what a cross-site simple POST would send) → 415; empty → 400
    assert.equal((await fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'abc' })).status, 415);
    assert.equal((await fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: '' })).status, 400);
    const r = await fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-opus') });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.text, /^안녕하세요 -m /);
    assert.match(j.text, /-l ko -nt -np -t \d+ --prompt 스파이더, 리뷰시트$/);
    assert.ok(!/ -bs 1/.test(j.text));   // 최종 전사는 정밀(beam) 그대로
    // 말하는 중 미리보기: 새로 쌓인 소리가 너무 짧으면 whisper 를 안 돌리고 end=from 그대로
    const lv = await (await fetch(base + '/api/stt?live=1&from=3.5', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-opus') })).json();
    assert.deepEqual([lv.text, lv.end], ['', 3.5]);
    assert.ok(!/\n/.test(j.text));
    // 무음이면 whisper 를 안 돌린다 — 최종 전사도(‘감사합니다’ 지어내기 방지)
    fs.writeFileSync(path.join(bin, 'silent'), '');
    assert.equal((await (await fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-opus') })).json()).text, '');
    fs.rmSync(path.join(bin, 'silent'));
    // whisper 가 지어낸 말만 나오면 버린다
    fs.writeFileSync(wh, '#!/bin/sh\necho " 감사합니다."\necho " 감사합니다."\n', { mode: 0o755 });
    assert.equal((await (await fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-opus') })).json()).text, '');
    assert.equal((await fetch(base + '/mic.js')).status, 200);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    await close();
  }
});

test('stt: REVIEW_SHEET_STT_REMOTE — 다른 맥이 적으면 그 글, 503 이면 이 맥 whisper 로 떨어진다', async () => {
  const dir = tmpDir();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-stt-bin-'));
  const ff = path.join(bin, 'ffmpeg'), wh = path.join(bin, 'whisper-cli'), model = path.join(bin, 'model.bin');
  fs.writeFileSync(ff, '#!/bin/sh\nfor a; do last="$a"; done\nhead -c 16044 /dev/urandom > "$last"\n', { mode: 0o755 });
  fs.writeFileSync(wh, '#!/bin/sh\necho "이 맥"\n', { mode: 0o755 });
  fs.writeFileSync(model, 'x');
  let code = 200, got = null;
  const remote = http.createServer((q, s) => {
    if (q.url === '/stt/ready') { s.writeHead(code); return s.end(); }
    const b = []; q.on('data', c => b.push(c)); q.on('end', () => { got = Buffer.concat(b).toString('latin1'); s.writeHead(code, { 'content-type': 'text/plain' }); s.end(code === 200 ? ' 다른 맥\n' : ''); });
  });
  await new Promise(r => remote.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  const { base, close } = await startServer(dir, 0);
  try {
    Object.assign(process.env, { REVIEW_SHEET_WHISPER_BIN: wh, REVIEW_SHEET_FFMPEG: ff, REVIEW_SHEET_WHISPER_MODEL: model, REVIEW_SHEET_VOCAB: path.join(bin, 'none'), REVIEW_SHEET_STT_REMOTE: `http://127.0.0.1:${remote.address().port}/stt` });
    const post = () => fetch(base + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-opus') }).then(r => r.json());
    assert.equal((await post()).text, '다른 맥');
    assert.match(got, /name="file"; filename="in.wav"/);   // whisper-server 와 같은 /inference 몸
    assert.match(got, /name="language"\r\n\r\nko/);
    code = 503;
    assert.equal((await post()).text, '이 맥');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    await close(); remote.close();
  }
});

test('stt: dropHallucination — 지어낸 말만이면 비우고, 진짜 말은 남기고 방송 인사 꼬리만 뗀다', () => {
  for (const t of ['감사합니다', '감사합니다. 감사합니다.', '시청해주셔서 감사합니다.', '구독과 좋아요 부탁드립니다', ' 네. ', 'MBC 뉴스 김철수입니다.']) assert.equal(dropHallucination(t), '', t);
  assert.equal(dropHallucination('리뷰시트 열어줘'), '리뷰시트 열어줘');
  assert.equal(dropHallucination('도와줘서 정말 감사합니다'), '도와줘서 정말 감사합니다');
  assert.equal(dropHallucination('배포 끝났어. 시청해주셔서 감사합니다.'), '배포 끝났어.');
  const vocab = ['리뷰시트', '스파이더', '히어로', '플릿', '이슈', 'PR'];
  assert.equal(dropHallucination('히어로, 플릿, 에피어로, 플릿', vocab), '');   // 잡음에 단어장 읊기
  assert.equal(dropHallucination('히어로 이슈 봐줘', vocab), '히어로 이슈 봐줘');   // 쉼표 없는 진짜 말
  assert.equal(dropHallucination('PR, 이슈 확인', vocab), 'PR, 이슈 확인');         // 단어장 밖 낱말이 섞이면 진짜 말
});

test('stt: binary lookup skips a same-named directory on PATH (launchd PATH=/opt/homebrew/Cellar → Cellar/ffmpeg/)', async () => {
  const { sttConfig } = await import('../bin/review-sheet.mjs');
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-path-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-path-b-'));
  fs.mkdirSync(path.join(a, 'ffmpeg'));
  fs.writeFileSync(path.join(b, 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, FF: process.env.REVIEW_SHEET_FFMPEG };
  try {
    delete process.env.REVIEW_SHEET_FFMPEG; process.env.PATH = `${a}:${b}`;
    assert.equal(sttConfig().ffmpeg, path.join(b, 'ffmpeg'));
  } finally { process.env.PATH = saved.PATH; if (saved.FF !== undefined) process.env.REVIEW_SHEET_FFMPEG = saved.FF; }
});

test('double send: same text twice within 3s is stored once (chat + memo), a different text or a later repeat is kept (hero 2026-10-07)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-dup-'));
  const { appendChat, newChat, readChatLog, sendMemo, readMemo } = await import('../bin/review-sheet.mjs');
  newChat(dir, 'dup', 'dup', 'root');
  const a = appendChat(dir, 'dup', 'hero', '같은 글'), b = appendChat(dir, 'dup', 'hero', '같은 글');
  assert.equal(a.id, b.id); assert.equal(readChatLog(dir, 'dup').length, 1);
  appendChat(dir, 'dup', 'root', '같은 글');             // another sender is not a double send
  appendChat(dir, 'dup', 'hero', '다른 글');
  assert.equal(readChatLog(dir, 'dup').length, 3);
  const m1 = sendMemo(dir, 'hero', '메모'), m2 = sendMemo(dir, 'hero', '메모');
  assert.equal(m1.id, m2.id); assert.equal(readMemo(dir, 'hero').messages.length, 1);
});

test('urgent: 🔥 on a sheet → top of its group, hero notice to the owner channel, off → notice again (hero 2026-10-08)', async () => {
  const dir = tmpDir();
  const { newChat, readChatLog, readUrgent } = await import('../bin/review-sheet.mjs');
  const mk = (name, from) => fs.writeFileSync(path.join(dir, name + '-data.js'),
    `window.SHEET = { id: '${name}', title: 'T-${name}', from: '${from}', createdAt: '2026-10-0${name === 'a' ? 2 : 1}T00:00:00Z', sections: [{ id: 's', code: 'S', title: 's', questions: [['1', 'q', ['① a'], '①', 'w']] }] };`);
  mk('a', 'infra'); mk('b', 'nochan');
  newChat(dir, 'infra', 'infra', 'infra:fleet2');
  const { base, close } = await startServer(dir, 0);
  try {
    const post = (d, on, ct = 'application/json') => fetch(base + '/__urgent?d=' + d, { method: 'POST', headers: { 'content-type': ct }, body: JSON.stringify({ on }) });
    assert.equal((await post('b', true, 'text/plain')).status, 415);   // cross-site simple POST can't flip it
    assert.equal((await post('zz', true)).status, 400);
    let j = await (await post('b', true)).json();
    assert.deepEqual([j.urgent, j.notified], [true, null]);             // no channel for 'nochan' — flag only
    let inbox = await (await fetch(base + '/api/inbox')).json();
    const order = inbox.sheets.filter(s => !s.error).map(s => s.name);
    assert.ok(order.indexOf('b') < order.indexOf('a'), 'urgent b above newer a');
    assert.equal(inbox.sheets.find(s => s.name === 'b').urgent, true);
    j = await (await post('a', true)).json();
    assert.equal(j.notified, 'infra');
    await post('a', true);                                               // already on — no second notice
    let log = readChatLog(dir, 'infra');
    assert.equal(log.length, 1); assert.equal(log[0].from, 'hero'); assert.match(log[0].text, /^🔥 긴급 지정: T-a/);
    await post('a', false);
    log = readChatLog(dir, 'infra');
    assert.equal(log.length, 2); assert.match(log[1].text, /^긴급 해제: T-a/);
    assert.deepEqual(Object.keys(readUrgent(dir)), ['b']);
    // from 이 빠진 시트(데이터 파일 통째 덮어쓰기) → 시트 이름 접두로 채널을 찾는다
    fs.writeFileSync(path.join(dir, 'infra-x-data.js'), "window.SHEET = { id: 'infra-x', title: 'T-x', sections: [] };");
    assert.equal((await (await post('infra-x', true)).json()).notified, 'infra');
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /rs-flag/);
    assert.match(execFileSync(process.execPath, [BIN, 'ls', dir], { encoding: 'utf8' }), /^🔥b\t/m);
  } finally { await close(); }
});

test('cli: assign gate — submitted sheets stay open until an issue/owner is recorded', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  fs.copyFileSync(path.join(dir, 'example-data.js'), path.join(dir, 'old-data.js'));
  const old = fs.readFileSync(path.join(dir, 'old-data.js'), 'utf8').replace(/id:\s*'example'/, "id: 'old'");
  fs.writeFileSync(path.join(dir, 'old-data.js'), old);
  fs.writeFileSync(path.join(dir, 'answers', 'old.json'), JSON.stringify({ sheet: 'old', savedAt: '2020-01-01T00:00:00.000Z', answers: { 'A-1': { pick: '①' } } }));
  const gh = ghStub({ [`${R}/issues/12`]: ghIssueFx(12) });
  const run = (...a) => { try { return { out: execFileSync('node', [BIN, ...a], { encoding: 'utf8', env: gh.env }), code: 0 }; } catch (e) { return { out: e.stdout, code: e.status }; } };
  // first use starts the gate — answers saved before it are exempt
  assert.deepEqual(run('unassigned', dir), { out: '', code: 0 });
  const save = at => fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: at, answers: { 'A-1': { pick: '①' } } }));
  save(new Date().toISOString());
  let r = run('unassigned', dir);
  assert.equal(r.code, 5); assert.match(r.out, /^example\t배정없음\t/);
  assert.match(run('ls', dir).out, /^example\t.*\t배정없음$/m);
  assert.equal(run('unassigned', dir, '--prefix', 'zzz').code, 0);
  assert.match(run('assign', dir, 'example', '#12', 'proj:ws1').out, /배정 #12 → proj:ws1 \(o\/r\)/);
  assert.match(run('unassigned', dir).out, /^example\t문항안붙음\t.*\(A-1\)$/m);   // 배정만으론 안 닫힌다 — 문항 장부(#40)
  assert.equal(run('items', dir, 'example', 'A-1', 'reject', '이번엔', '안', '함').code, 0);
  assert.deepEqual(run('unassigned', dir), { out: '', code: 0 });
  assert.doesNotMatch(run('ls', dir).out, /배정없음|답바뀜|문항안붙음/);
  // 같은 답으로 다시 저장 = 그대로, hero 가 답을 바꾸면 그 문항만 다시 열린다
  const save2 = (at, pick) => fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: at, answers: { 'A-1': { pick } } }));
  save2(new Date(Date.now() + 60000).toISOString(), '①');
  assert.equal(run('unassigned', dir).code, 0);
  save2(new Date(Date.now() + 120000).toISOString(), '②');
  assert.match(run('unassigned', dir).out, /^example\t문항안붙음\t.*\(A-1·답바뀜\)$/m);
});

test('stage: owner reports each step as an end-state tag on the sheet row — 근거(PR·커밋)가 칩에 붙는다 (hero 2026-10-13/14, #40)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const gh = ghStub({ [`${R}/issues/7`]: ghIssueFx(7), [`${R}/pulls/9`]: ghPrFx(9, true), [`repos/o/r/compare/m000009aaaa...live123456`]: { status: 'ahead' } });
  const run = runIn(gh.env);
  run('unassigned', dir);                                   // gate starts now
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers: { 'A-1': { pick: '①' } } }));
  let r = run('stage', dir, 'example', '머지', '--pr', '9');
  assert.equal(r.code, 1); assert.match(r.out, /아직 배정 안 됨/);
  assert.equal(run('assign', dir, 'example', '#7', 'proj:ws1').code, 0);
  assert.match(run('stage', dir, 'example', 'merged', '--pr', '9', '정리').out, /^example\t🔀 머지됨 #9 — 정리/);
  assert.equal(run('stage', dir, 'example', '반쯤').code, 1);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'assign', 'example.json'), 'utf8'));
  assert.deepEqual(a.stages.map(x => x.stage), ['배정', '머지']);
  assert.deepEqual([a.stages[1].pr, a.stages[1].mergeCommit, a.stages[1].by], ['o/r#9', 'm000009aaaa', 'proj:ws9']);
  assert.match(run('ls', dir).out, /\t문항안붙음$/m);
  assert.equal(run('items', dir, 'example', 'A-1', 'done', '--pr', '9').code, 0);
  assert.match(run('ls', dir).out, /\t머지 #7$/m);
  assert.equal(run('unassigned', dir).code, 0);             // 24h '멈춤' 은 없어졌다 — 이슈가 열려 있으면 조용
  assert.match(run('stage', dir, 'example', '라이브', '--sha', 'live123456', '16:05 배포').out, /^example\t🚀 배포됨 live123 — 16:05 배포/);
  assert.equal(run('unassigned', dir).code, 0);
  // 끝난 상태 태그 (hero 2026-10-14: 메인만? 배포 큐? 배포됨? 어드민 스위치? 언제?)
  assert.equal(stageTag({ stage: '라이브', off: true, eta: '다음 시즌' }), '🚀 배포됨 · 스위치 꺼짐 · 다음 시즌 공개');
  assert.equal(stageTag({ stage: '배포대기', eta: '15:00' }), '⏳ 배포 대기 · 15:00 예정');
  assert.equal(stageTag({ stage: '머지', pr: 'o/r#9' }), '🔀 머지됨 #9');
  assert.equal(stageTag({ stage: '되돌림', pr: 'o/r#11' }), '↩ 되돌림 #11');
  const { base, close } = await startServer(dir, 0);
  try {
    const inbox = await (await fetch(base + '/api/inbox')).json();
    const x = inbox.sheets.find(s => s.name === 'example').assign;
    assert.deepEqual([x.stage, x.tag, x.sha, x.pr], ['라이브', '🚀 배포됨 live123', 'live123456', 'o/r#9']);
    assert.equal(inbox.reports, undefined);
    assert.equal((await fetch(base + '/__report-ack?d=example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /rs-tag/); assert.doesNotMatch(html, /rs-report-h|오른쪽으로 밀면/);
  } finally { await close(); }
});

test('AC1·AC2: stage 근거 — 머지 = --pr MERGED, 라이브 = --sha 가 머지 커밋 포함 또는 --off <이유>, 같은 단계 두 번 거부 (#40)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const gh = ghStub({ [`${R}/issues/7`]: ghIssueFx(7), [`${R}/pulls/9`]: ghPrFx(9, true), [`${R}/pulls/10`]: ghPrFx(10, false),
    'repos/o/r/compare/m000009aaaa...old0000': { status: 'behind' }, 'repos/o/r/compare/m000009aaaa...new1111': { status: 'identical' } });
  const run = runIn(gh.env);
  run('unassigned', dir);
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers: { 'A-1': { pick: '①' } } }));
  run('assign', dir, 'example', '7', 'proj:ws1');
  let r = run('stage', dir, 'example', '머지');
  assert.notEqual(r.code, 0); assert.match(r.out, /근거 필요 — --pr/);
  r = run('stage', dir, 'example', '머지', '--pr', '10');
  assert.notEqual(r.code, 0); assert.match(r.out, /머지 안 됨 \(open\)/);
  r = run('stage', dir, 'example', '머지', '--pr', '404');
  assert.notEqual(r.code, 0); assert.match(r.out, /gh api .*pulls\/404 실패/);
  r = run('stage', dir, 'example', '라이브', '--sha', 'new1111');
  assert.notEqual(r.code, 0); assert.match(r.out, /어떤 머지가 나갔는지 모름/);
  assert.equal(run('stage', dir, 'example', '머지', '--pr', '9').code, 0);
  r = run('stage', dir, 'example', '머지', '--pr', '9');
  assert.notEqual(r.code, 0); assert.match(r.out, /'머지' 는 이미 찍힘 .*proj:ws9/);
  r = run('stage', dir, 'example', '라이브');
  assert.notEqual(r.code, 0); assert.match(r.out, /--sha <운영 커밋>.*또는 --off <이유>/);
  r = run('stage', dir, 'example', '라이브', '--off');
  assert.notEqual(r.code, 0);                               // 이유 없는 --off 는 근거가 아니다
  r = run('stage', dir, 'example', '라이브', '--sha', 'old0000');
  assert.notEqual(r.code, 0); assert.match(r.out, /old0000 에 머지 커밋 m000009 \(o\/r#9\) 이 없다/);
  assert.equal(run('stage', dir, 'example', '라이브', '--sha', 'new1111').code, 0);
  assert.notEqual(run('stage', dir, 'example', '라이브', '--sha', 'new1111').code, 0);
  // --off <이유> 도 라이브 근거 (스위치 꺼짐)
  const d2 = tmpDir(); fs.mkdirSync(path.join(d2, 'answers'));
  fs.writeFileSync(path.join(d2, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers: { 'A-1': { pick: '①' } } }));
  run('assign', d2, 'example', '#7', 'proj:ws1');
  assert.match(run('stage', d2, 'example', '라이브', '--off', '어드민 스위치 꺼 둠', '--eta', '다음 시즌').out, /🚀 배포됨 · 스위치 꺼짐 · 다음 시즌 공개/);
  const a = JSON.parse(fs.readFileSync(path.join(d2, 'assign', 'example.json'), 'utf8'));
  assert.equal(a.stages.at(-1).offReason, '어드민 스위치 꺼 둠');
});

test('되돌림: 근거 PR 이 revert 되면 unassigned 가 시트를 다시 열고, 다시 머지 단계를 찍을 수 있다 (#40)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const fx = { [`${R}/issues/7`]: ghIssueFx(7), [`${R}/pulls/9`]: ghPrFx(9, true), [`${R}/pulls/12`]: ghPrFx(12, true), 'search/issues': { items: [] } };
  const gh = ghStub(fx), run = runIn(gh.env);
  run('unassigned', dir);
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers: { 'A-1': { pick: '①' } } }));
  run('assign', dir, 'example', '#7', 'proj:ws1');
  run('stage', dir, 'example', '머지', '--pr', '9');
  run('items', dir, 'example', 'A-1', 'done', '--pr', '9');
  assert.equal(run('unassigned', dir).code, 0);
  assert.ok(gh.calls().some(c => /^search\/issues\?q=repo%3Ao%2Fr/.test(c.args[1])));
  // 한 시간 안에는 다시 안 묻는다
  const n = gh.calls().length; run('unassigned', dir);
  assert.equal(gh.calls().filter(c => c.args[1].startsWith('search/')).length, gh.calls().slice(0, n).filter(c => c.args[1].startsWith('search/')).length);
  gh.set({ ...fx, 'search/issues': { items: [{ number: 11, title: 'Revert "T9"', body: 'Reverts o/r#9' }] } });
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'assign', 'example.json'), 'utf8'));
  a.revertChecked = {}; fs.writeFileSync(path.join(dir, 'assign', 'example.json'), JSON.stringify(a));
  const r = run('unassigned', dir);
  assert.equal(r.code, 5); assert.match(r.out, /^example\t되돌림\t.*o\/r#11 가 o\/r#9 를 되돌림/m);
  assert.match(run('items', dir, 'example').out, /^A-1\t되돌려짐\tdone o\/r#9/m);
  assert.equal(run('stage', dir, 'example', '머지', '--pr', '12').code, 0);   // 되돌림 뒤 새 머지 OK
  run('items', dir, 'example', 'A-1', 'done', '--pr', '12');
  assert.equal(run('unassigned', dir).code, 0);
});

test('AC3: items 장부 — 답한 문항(메모·_ask 포함)마다 붙어야 닫힘, unassigned 는 안 붙음·이슈 닫혔는데 단계 덜 됨만 (#40)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  fs.writeFileSync(path.join(dir, 'next-data.js'), "window.SHEET = { id: 'next', title: '다음', sections: [] };");
  const fx = { [`${R}/issues/7`]: ghIssueFx(7), [`${R}/issues/8`]: ghIssueFx(8), [`${R}/issues/9`]: ghIssueFx(9, { pull_request: {} }), [`${R}/pulls/9`]: ghPrFx(9, true), [`${R}/pulls/10`]: ghPrFx(10, false), 'search/issues': { items: [] } };
  const gh = ghStub(fx), run = runIn(gh.env);
  run('unassigned', dir);
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(),
    answers: { 'A-1': { pick: '①' }, 'A-2': { memo: '이건 나중에' }, 'A-memo': { memo: '전체 메모' }, _ask: { memo: '제출 뒤 덧붙인 질문' }, 'A-3': {} } }));
  assert.match(run('unassigned', dir).out, /^example\t배정없음\t/m);
  run('assign', dir, 'example', '#7', 'proj:ws1');
  let r = run('items', dir, 'example');
  assert.equal(r.code, 5);
  assert.deepEqual(r.out.trim().split('\n'), ['A-1\t안 붙음', 'A-2\t안 붙음', 'A-memo\t안 붙음', '_ask\t안 붙음']);   // 빈 답(A-3)은 대상 아님
  assert.match(run('unassigned', dir).out, /^example\t문항안붙음\t.*\(A-1 A-2 A-memo _ask\)$/m);
  assert.match(run('items', dir, 'example', 'A-3', 'reject').out, /답이 없다/);
  assert.match(run('items', dir, 'example', 'A-1', 'done').out, /--pr <번호> 또는 --rule/);
  assert.match(run('items', dir, 'example', 'A-1', 'done', '--pr', '9', '--rule', '규칙').out, /하나만/);
  assert.match(run('items', dir, 'example', 'A-1', 'done', '--pr', '10').out, /머지 안 됨/);
  assert.match(run('items', dir, 'example', 'A-2', 'defer', '--issue', '9').out, /는 PR/);
  assert.match(run('items', dir, 'example', 'A-1', 'skip').out, /done · defer · reject · moved/);
  assert.match(run('items', dir, 'example', 'A-memo', 'moved', 'example').out, /자기 시트/);
  assert.match(run('items', dir, 'example', 'A-memo', 'moved', 'nope').out, /옮긴 시트 이름/);
  assert.match(run('items', dir, 'example', 'A-1', 'done', '--pr', '9').out, /^example\tA-1\tdone o\/r#9\t남음 3\/4$/m);
  assert.match(run('items', dir, 'example', 'A-2', 'done', '--rule', '새 창은 오퍼스 기본 — 메모리 규칙').out, /^example\tA-2\tdone 규칙: 새 창은 오퍼스 기본 — 메모리 규칙\t남음 2\/4$/m);   // 코드 PR 없이 규칙으로 적용(#49)
  assert.match(run('items', dir, 'example').out, /^A-2\tok\tdone 규칙: 새 창은/m);
  run('items', dir, 'example', 'A-memo', 'moved', 'next');
  assert.equal(run('unassigned', dir).code, 5);
  assert.match(run('items', dir, 'example', '_ask', 'reject', '채팅으로', '답함').out, /남음 0\/4/);
  assert.equal(run('items', dir, 'example').code, 0);
  assert.deepEqual(run('unassigned', dir), { out: '', code: 0 });
  // 이슈가 닫혔는데 라이브·끝 전이면 보고, 끝 을 찍으면 조용
  gh.set({ ...fx, [`${R}/issues/7`]: ghIssueFx(7, { state: 'closed' }) });
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'assign', 'example.json'), 'utf8'));
  delete a.issueCheckedAt; fs.writeFileSync(path.join(dir, 'assign', 'example.json'), JSON.stringify(a));
  r = run('unassigned', dir);
  assert.equal(r.code, 5); assert.match(r.out, /^example\t이슈닫힘\t.*배정 #7 — 이슈는 닫혔는데 라이브·끝 아님/m);
  run('stage', dir, 'example', '끝');
  assert.deepEqual(run('unassigned', dir), { out: '', code: 0 });
});

test('AC4: assign 검사 — PR 번호·뒤바뀐 인자·이상한 담당 거부, migrate-assign 이 옛 뒤바뀜을 백업 남기고 고침 (#40)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const gh = ghStub({ [`${R}/issues/7`]: ghIssueFx(7), [`${R}/issues/9`]: ghIssueFx(9, { pull_request: { url: 'x' } }), 'repos/x/y/issues/5': ghIssueFx(5, { html_url: 'https://github.com/x/y/issues/5' }) });
  const run = runIn(gh.env);
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers: { 'A-1': { pick: '①' } } }));
  let r = run('assign', dir, 'example', 'proj:ws1', '#7');
  assert.equal(r.code, 1); assert.match(r.out, /순서가 뒤바뀜/);
  r = run('assign', dir, 'example', '#9', 'proj:ws1');
  assert.equal(r.code, 1); assert.match(r.out, /#9 는 PR/);
  r = run('assign', dir, 'example', 'abc', 'proj:ws1');
  assert.equal(r.code, 1); assert.match(r.out, /이슈는 숫자/);
  r = run('assign', dir, 'example', '#7', 'ws1');
  assert.equal(r.code, 1); assert.match(r.out, /담당은 <도메인>:<창>/);
  assert.equal(fs.existsSync(path.join(dir, 'assign', 'example.json')), false);
  assert.match(run('assign', dir, 'example', 'x/y#5', 'proj:ws1').out, /배정 #5 → proj:ws1 \(x\/y\)/);
  // 옛 뒤바뀐 기록 (검사 전 CLI 가 그대로 받아 적던 것)
  const old = (id, issue, owner) => fs.writeFileSync(path.join(dir, 'assign', id + '.json'), JSON.stringify({ issue, owner, at: '2026-10-10T00:00:00.000Z', stages: [{ stage: '배정', note: `${issue} → ${owner}`, at: '2026-10-10T00:00:00.000Z' }] }));
  old('s1', 'web:ws2', '#31'); old('s2', 'proj:main', 'o/r#40'); old('s3', '#12', 'proj:ws1');
  r = run('migrate-assign', dir, '--dry-run');
  assert.match(r.out, /^s1\tweb:ws2 #31\t→ #31 web:ws2$/m); assert.match(r.out, /고칠 것 2 \/ 배정 4$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'assign', 's1.json'), 'utf8')).issue, 'web:ws2');   // dry-run 은 안 씀
  r = run('migrate-assign', dir);
  assert.match(r.out, /고침 2 \/ 배정 4\t백업 /);
  const bak = r.out.match(/백업 (\S+)/)[1];
  assert.equal(JSON.parse(fs.readFileSync(path.join(bak, 's1.json'), 'utf8')).issue, 'web:ws2');
  const s1 = JSON.parse(fs.readFileSync(path.join(dir, 'assign', 's1.json'), 'utf8')), s2 = JSON.parse(fs.readFileSync(path.join(dir, 'assign', 's2.json'), 'utf8'));
  assert.deepEqual([s1.issue, s1.owner, s1.stages[0].note], ['#31', 'web:ws2', '#31 → web:ws2']);
  assert.deepEqual([s2.issue, s2.repo], ['#40', 'o/r']);
  assert.match(run('migrate-assign', dir).out, /고침 0 \/ 배정 4/);
});

test('AC5: record — read 전체(_ask·메모·문항 질문)를 이슈 댓글로, 다시 저장되면 바뀐 줄만 (#40)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const gh = ghStub({ [`${R}/issues/7`]: ghIssueFx(7), [`${R}/issues/7/comments`]: { html_url: 'https://github.com/o/r/issues/7#issuecomment-1' } });
  const run = runIn(gh.env);
  const save = answers => fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers }));
  save({ 'A-1': { pick: '① 선택지 하나' }, 'A-2': { memo: '둘 다 싫다' }, _ask: { memo: '제출 뒤 덧붙인 묻기' } });
  assert.match(run('record', dir, 'example').out, /붙일 이슈가 없다/);
  let r = run('record', dir, 'example', '--issue', '7');
  assert.equal(r.code, 0); assert.match(r.out, /^example\t→ o\/r#7\t\d+줄\thttps:/);
  let posts = gh.calls().filter(c => c.args.includes('--input'));
  assert.equal(posts.length, 1);
  let body = JSON.parse(posts[0].input).body;
  assert.match(body, /hero 추가 질문.*제출 뒤 덧붙인 묻기/); assert.match(body, /둘 다 싫다/); assert.match(body, /① 선택지 하나/);
  assert.match(run('record', dir, 'example', '--issue', '7').out, /바뀐 것 없음/);
  assert.equal(gh.calls().filter(c => c.args.includes('--input')).length, 1);
  save({ 'A-1': { pick: '② 선택지 둘' }, 'A-2': { memo: '둘 다 싫다' }, _ask: { memo: '제출 뒤 덧붙인 묻기' } });
  r = run('record', dir, 'example', '--issue', '7');
  assert.match(r.out, /\t1줄\t/);
  posts = gh.calls().filter(c => c.args.includes('--input'));
  body = JSON.parse(posts[1].input).body;
  assert.match(body, /바뀐 답/); assert.match(body, /② 선택지 둘/); assert.match(body, /\| # \| 질문/);
  assert.doesNotMatch(body, /둘 다 싫다|덧붙인 묻기/);
  // 배정이 있으면 --issue 없이 그 이슈로
  run('assign', dir, 'example', '#7', 'proj:ws1');
  save({ 'A-1': { pick: '② 선택지 둘' }, 'A-2': { memo: '바꾼 메모' }, _ask: { memo: '제출 뒤 덧붙인 묻기' } });
  assert.match(run('record', dir, 'example').out, /→ o\/r#7\t1줄/);
});

test('report: 보고 시트 ✓ 확인 — checked.json 만, answers 안 씀(세션 안 깨움), 확인할 보고 묶음, 옛 머지 제목은 배지로 (hero 2026-10-15)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const sheet = (id, extra) => fs.writeFileSync(path.join(dir, id + '-data.js'), 'window.SHEET = ' + JSON.stringify({ id, title: 't', sections: [{ id: 'a', code: 'A', title: 's', questions: [] }], ...extra }) + ';');
  sheet('rep-new', { report: 'merged', title: '제출 버튼 위치' });
  sheet('rep-old', { title: '✅ 머지했습니다 — 마이크 단축키 (PR #13)' });
  sheet('plain', { title: '머지 순서 정하기' });
  sheet('plan', { title: '이렇게 해놓겠습니다 — 부분 제출 표시', sections: [{ id: 'a', code: 'A', title: 's', questions: [{ k: '1', q: '확인', opts: [['확인'], ['의견']] }] }] });
  sheet('plan-go', { title: '이렇게 해놓겠습니다 — 러너 연결', sections: [{ id: 'a', code: 'A', title: 's', questions: [{ k: '1', q: '머지할까', opts: [['① 머지'], ['② 보류']] }] }] });
  sheet('plan-pick', { title: '위키 고치기 — 1번 방식 고르기 · 2번 이렇게 해놓겠습니다', sections: [{ id: 'a', code: 'A', title: 's', questions: [{ k: '1', q: '방식', opts: [['① 규칙 문구만'], ['② 코드까지']] }] }] });
  sheet('plan-ask', { title: '승인 요청 — 이렇게 해놓겠습니다' });
  sheet('mixed', { title: '머지했습니다(위키) · 이렇게 해놓겠습니다(장치)', sections: [{ id: 'b', code: 'B', title: 's', questions: [{ k: '1', q: '머지?', opts: [['① 머지 + 시험'], ['② 보류']] }] }] });
  const run = (...a) => { try { return { out: execFileSync('node', [BIN, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; } catch (e) { return { out: e.stdout + e.stderr, code: e.status }; } };
  const { base, close } = await startServer(dir, 0);
  try {
    let inbox = await (await fetch(base + '/api/inbox')).json();
    const by = n => inbox.sheets.find(s => s.name === n);
    assert.deepEqual([by('rep-new').report, by('rep-new').title], ['🔀 머지됨', '제출 버튼 위치']);
    assert.deepEqual([by('rep-old').report, by('rep-old').title], ['🔀 머지됨', '마이크 단축키 (PR #13)']);
    assert.deepEqual([by('plain').report, by('plain').title], ['', '머지 순서 정하기']);
    assert.deepEqual([by('plan').report, by('plan').title], ['📌 보고', '부분 제출 표시']);   // 해놓겠습니다 = 보고, 진행(hero 2026-10-15)
    assert.equal(by('plan-ask').report, '📌 보고');                         // 해놓겠습니다 시트의 '승인 요청 = …' 첫 줄은 결정 신호 아님
    assert.equal(by('plan-go').report, '📌 보고');                         // '① 머지' 는 진행 알림
    assert.equal(by('plan-pick').report, '');                              // 진짜 고를 게 있으면 결정                               // 승인 요청은 답 기다림
    assert.notEqual(by('mixed').report, '');                               // 머지했습니다 · 해놓겠습니다 + '① 머지' = 보고(hero 2026-10-15, #21 뒤집음)
    const post = (d, on) => fetch(base + '/__check?d=' + d, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
    assert.equal((await post('plain', true)).status, 400);                 // 보고 시트만
    assert.equal((await fetch(base + '/__check?d=rep-new', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    const j = await (await post('rep-new', true)).json();
    assert.ok(j.checkedAt);
    assert.equal(fs.existsSync(path.join(dir, 'answers', 'rep-new.json')), false);   // wait 가 안 깬다
    assert.equal((await (await fetch(base + '/__check?d=rep-new')).json()).checkedAt, j.checkedAt);
    inbox = await (await fetch(base + '/api/inbox')).json();
    assert.equal(by('rep-new').checkedAt, j.checkedAt);
    assert.match(run('checks', dir).out, /^rep-new\t.+\t🔀 머지됨 제출 버튼 위치$/m);
    assert.match(run('checks', dir, '--open').out, /^rep-old\t확인 안 함\t/m);
    assert.doesNotMatch(run('checks', dir, '--open').out, /rep-new|plain\t/);
    await post('rep-new', false);
    assert.equal(run('checks', dir).out, '');
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /rs-check/); assert.match(html, /확인할 보고/);
  } finally { await close(); }
});

test('partial: 부분 제출 — 안 고른 문항(메모만 포함)이 남으면 배지·read 안내·unassigned 에 뜬다, hero 답 기다림 칸엔 안 올림 (hero 2026-10-15)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const q = k => ({ k, q: '질문' + k, opts: [['① 가'], ['② 나']] });
  const sheet = (id, extra) => fs.writeFileSync(path.join(dir, id + '-data.js'), 'window.SHEET = ' + JSON.stringify({ id, title: id, sections: [{ id: 'a', code: 'A', title: 's', questions: [q('1'), q('2'), q('3')] }], ...extra }) + ';');
  const ans = (id, answers) => fs.writeFileSync(path.join(dir, 'answers', id + '.json'), JSON.stringify({ savedAt: new Date().toISOString(), answers }));
  const run = (...a) => { try { return { out: execFileSync('node', [BIN, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; } catch (e) { return { out: e.stdout + e.stderr, code: e.status }; } };
  run('unassigned', dir);   // 배정 게이트 시작 — 그 뒤 답만 대상
  await new Promise(r => setTimeout(r, 5));
  sheet('part'); ans('part', { 'A-1': { pick: '① 가' }, 'A-2': { memo: '이거 왜 필요해? 이게 막혀서 3번은 못 고름' } });
  sheet('full'); ans('full', { 'A-1': { pick: '① 가' }, 'A-2': { pick: '② 나' }, 'A-3': { pick: '① 가' } });
  const { base, close } = await startServer(dir, 0);
  try {
    const inbox = await (await fetch(base + '/api/inbox')).json();
    const by = n => inbox.sheets.find(s => s.name === n);
    assert.equal(by('part').partial, 2); assert.equal(by('full').partial, undefined);
    assert.equal(by('part').submitted, true);
    assert.match(run('read', dir, 'part').out, /부분 제출 — 안 고른 문항 2개 \(A-2, A-3\).*남은 문항만 새 id 시트로/);
    assert.doesNotMatch(run('read', dir, 'full').out, /부분 제출/);
    const u = run('unassigned', dir);
    assert.match(u.out, /^part\t배정없음\t.*부분제출\(미선택 2\)$/m); assert.match(u.out, /^full\t배정없음\t.*\tfull$/m);
    assert.match(await (await fetch(base + '/')).text(), /부분 제출/);
  } finally { await close(); }
});

test('board: 진행판 — CLI writes board.json (cleaned), /api/board serves it, /board page loads, index links it (hero 2026-10-13)', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'in.json');
  fs.writeFileSync(src, JSON.stringify({ title: '진행판', cards: [
    { id: 'x#1', title: '빠른 일', status: 'doing', priority: 'P1', owner: 'a:main', mode: 'claude' },
    { id: 'x#2', title: 'CI 기다림', status: 'doing', owner: ['a:w1'], mode: 'system', modeNote: 'CI', url: 'javascript:alert(1)' },
    { title: '할 일', status: 'weird', mode: 'nope' }, { status: 'done' },
  ] }));
  const out = execFileSync('node', [BIN, 'board', dir, src], { encoding: 'utf8' });
  assert.match(out, /카드 3/);   // title 없는 카드는 버림
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
  assert.deepEqual(b.cards.map(c => c.status), ['doing', 'doing', 'todo']);
  assert.deepEqual(b.cards[0].owner, ['a:main']);
  assert.equal(b.cards[1].url, undefined);   // http(s) 만
  assert.equal(b.cards[2].mode, undefined);
  assert.match(execFileSync('node', [BIN, 'board', dir], { encoding: 'utf8' }), /doing\t2/);
  const srv = await startServer(dir, 0);
  try {
    const j = await (await fetch(srv.base + '/api/board')).json();
    assert.equal(j.board.cards.length, 3);
    assert.match(await (await fetch(srv.base + '/board')).text(), /<title>진행판<\/title>/);
    assert.match(await (await fetch(srv.base + '/')).text(), /href="\/board"/);
  } finally { await srv.close(); }
});

test('추가 질문: _ask memo → owner channel gets one hero notice per new/changed text, read shows it on top, page has the box (hero 2026-10-13)', async () => {
  const dir = tmpDir();
  const { newChat, readChatLog } = await import('../bin/review-sheet.mjs');
  fs.writeFileSync(path.join(dir, 'a-data.js'), `window.SHEET = { id: 'a', title: 'T-a', from: 'infra', sections: [{ id: 's', code: 'S', title: 's', questions: [['1', 'q', ['① a'], '①', 'w']] }] };`);
  newChat(dir, 'infra', 'infra', 'infra:fleet2');
  const { base, close } = await startServer(dir, 0);
  try {
    const post = answers => fetch(base + '/__answers?sheet=a', { method: 'POST', body: JSON.stringify({ answers }) }).then(r => r.json());
    let j = await post({ 'S-1': { pick: '① a' } });
    assert.equal(j.notified, null);                                      // no question → no notice
    j = await post({ 'S-1': { pick: '① a' }, _ask: { memo: '이거 언제 끝나?' } });
    assert.equal(j.notified, 'infra');
    j = await post({ 'S-1': { pick: '① a' }, _ask: { memo: '이거 언제 끝나?' } });
    assert.equal(j.notified, null);                                      // same text again → no repeat
    const log = readChatLog(dir, 'infra');
    assert.equal(log.length, 1); assert.equal(log[0].from, 'hero'); assert.match(log[0].text, /추가 질문 \(시트 a · T-a\): 이거 언제 끝나\?/);
    const md = execFileSync('node', [BIN, 'read', dir, 'a'], { encoding: 'utf8' });
    assert.match(md.split('\n').slice(0, 5).join('\n'), /hero 추가 질문.*이거 언제 끝나\?/);
    assert.match(fs.readFileSync(path.join(path.dirname(BIN), '..', 'web', 'sheet.html'), 'utf8'), /data-q="_ask"/);
  } finally { await close(); }
});

test('문항 질문: ＋ 이것만 묻기 → 담당 채널로 그 문항만, 시트는 제출 안 됨, ask-reply/↩ 답장이 시트에 뜸, 답 없으면 허브에 한 번 (hero 2026-10-16)', async () => {
  const dir = tmpDir();
  const { newChat, readChatLog, appendChat, askReply, askWatch, setHub } = await import('../bin/review-sheet.mjs');
  fs.writeFileSync(path.join(dir, 'infra-x-data.js'), `window.SHEET = { id: 'infra-x', title: 'T-x', from: 'infra', sections: [{ id: 's', code: 'S', title: 's', questions: [['1', 'q', ['① a', '② b'], '①', 'w']] }] };`);
  newChat(dir, 'root', 'root', 'root:fleet2', true); newChat(dir, 'infra', 'infra', 'infra:fleet2');
  const { base, close } = await startServer(dir, 0);
  try {
    const ask = (body, ct = 'application/json') => fetch(base + '/__ask?d=infra-x', { method: 'POST', headers: { 'content-type': ct }, body: JSON.stringify(body) });
    assert.equal((await ask({ q: 'S-1', text: 'x' }, 'text/plain')).status, 415);
    assert.equal((await ask({ q: 'S-1', text: '  ' })).status, 400);
    const j = await (await ask({ q: 'S-1', label: '1 <b>q</b>', text: '② 고르면 뭐가 달라져?' })).json();
    assert.equal(j.ch, 'infra');                                            // 담당 세션 직행
    const m = readChatLog(dir, 'infra').at(-1);
    assert.equal(m.from, 'hero'); assert.deepEqual(m.ask, { d: 'infra-x', q: 'S-1', text: '② 고르면 뭐가 달라져?', label: '1 q' });
    assert.match(m.text, /문항 질문 \(시트 infra-x · S-1 「1 q」\): ② 고르면/);
    assert.equal((await (await fetch(base + '/__answers?sheet=infra-x', { cache: 'no-store' })).json()).savedAt, undefined);   // 제출 안 됨
    let asks = await (await fetch(base + '/api/asks?d=infra-x')).json();
    assert.equal(asks.length, 1); assert.deepEqual(asks[0].replies, []);
    appendChat(dir, 'infra', 'infra:fleet2', '② 면 배포가 하루 늦어요', null, m.id);          // chat say --re 와 같은 길
    execFileSync('node', [BIN, 'ask-reply', dir, 'infra-x', 'S-1', '덧붙여: 비용은 같아요'], { encoding: 'utf8' });
    asks = await (await fetch(base + '/api/asks?d=infra-x')).json();
    assert.deepEqual(asks[0].replies.map(r => r.text), ['② 면 배포가 하루 늦어요', '덧붙여: 비용은 같아요']);
    assert.match(execFileSync('node', [BIN, 'asks', dir, 'infra-x'], { encoding: 'utf8' }), /S-1\t#\w+\t답 2/);
    // 답 없는 질문 → stale 지나면 허브(root)에 한 번만
    await ask({ q: 'S-memo', text: '이건 언제?' });
    const stop = askWatch(dir, 30, 0); await new Promise(r => setTimeout(r, 150)); stop();
    const hub = readChatLog(dir, 'root').filter(x => x.askStale);
    assert.equal(hub.length, 1); assert.match(hub[0].text, /답 없음.*S-memo.*이건 언제\?/);
    const page = fs.readFileSync(path.join(path.dirname(BIN), '..', 'web', 'sheet.html'), 'utf8');
    assert.match(page, /＋ 이것만 묻기/); assert.match(page, /\/__ask\?d=/);
  } finally { await close(); }
});

test('문항 질문: from 이 창 이름까지(pkch:서버)면 그 도메인 :main 채널로 — 허브로 새지 않음 (hero 2026-10-18)', async () => {
  const dir = tmpDir();
  const { newChat, askItem } = await import('../bin/review-sheet.mjs');
  fs.writeFileSync(path.join(dir, 'pkch-y-data.js'), `window.SHEET = { id: 'pkch-y', title: 'T-y', from: 'pkch:서버', sections: [{ id: 's', code: 'S', title: 's', questions: [['1', 'q', ['① a'], '①', 'w']] }] };`);
  newChat(dir, 'root', 'root', 'root:hub', true); newChat(dir, 'pkch-main', 'pkch', 'pkch:main');
  assert.equal(askItem(dir, 'pkch-y', 'S-1', '', '이거 뭐야?').ch, 'pkch-main');
  fs.writeFileSync(path.join(dir, 'zz-data.js'), `window.SHEET = { id: 'zz', title: 'T-z', from: 'zz:w', sections: [{ id: 's', code: 'S', title: 's', questions: [['1', 'q', ['① a'], '①', 'w']] }] };`);
  assert.equal(askItem(dir, 'zz', 'S-1', '', '도메인 채널 없음').ch, 'root');      // 그 도메인 채널이 없으면 허브
});

test('push: 폰 알림 — RFC 8291 시험값, VAPID 서명, 구독 → 새 시트·세션 글만 알림(hero 글·보고 시트 X) → 410 이면 구독 삭제 (hero 2026-10-16)', async () => {
  const crypto = await import('node:crypto');
  const { encrypt, vapidAuth, vapidKeys, readSubs } = await import('../bin/push.mjs');
  const { newChat, appendChat } = await import('../bin/review-sheet.mjs');
  // RFC 8291 §5 시험값
  const ct = encrypt('When I grow up, I want to be a watermelon', { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' });
  assert.equal(ct.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const dir = tmpDir();
  const k = vapidKeys(dir);
  assert.equal(vapidKeys(dir).publicKey, k.publicKey);                     // 한 번 만들면 그대로
  assert.equal(fs.statSync(path.join(dir, 'push', 'vapid.json')).mode & 0o777, 0o600);
  const auth = vapidAuth('https://web.push.apple.com/abc', k, 'mailto:x@y');
  const [, h, p, sig] = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=/.exec(auth);
  const pub = Buffer.from(k.publicKey, 'base64url');
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, 'https://web.push.apple.com');
  // 폰 쪽 키 + 가짜 푸시 서버
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const uaAuth = crypto.randomBytes(16);
  const hk = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
  const decrypt = b => { const salt = b.subarray(0, 16), idlen = b[20], asPub = b.subarray(21, 21 + idlen), body = b.subarray(21 + idlen);
    const ikm = hk(uaAuth, ua.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
    const d = crypto.createDecipheriv('aes-128-gcm', hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
    d.setAuthTag(body.subarray(-16)); const pt = Buffer.concat([d.update(body.subarray(0, -16)), d.final()]);
    return JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString()); };
  const got = []; let reply = 201;
  const http = await import('node:http');
  const fake = http.createServer((req, res) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => { got.push({ h: req.headers, msg: decrypt(Buffer.concat(c)) }); res.writeHead(reply); res.end(); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${fake.address().port}/push/1`;
  const sheet = (id, extra) => fs.writeFileSync(path.join(dir, id + '-data.js'), 'window.SHEET = ' + JSON.stringify({ id, title: id + ' 제목', from: 'infra', sections: [{ id: 'a', code: 'A', title: 's', questions: [] }], ...extra }) + ';');
  sheet('old');
  newChat(dir, 'infra', '인프라', 'infra:fleet2');
  const saved = process.env.REVIEW_SHEET_PUSH_MS; process.env.REVIEW_SHEET_PUSH_MS = '80';
  const { base, close } = await startServer(dir, 0);
  const until = async f => { for (let i = 0; i < 60 && !f(); i++) await new Promise(r => setTimeout(r, 50)); };
  try {
    assert.equal((await (await fetch(base + '/api/push')).json()).publicKey, k.publicKey);
    const subscription = { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } };
    assert.equal((await fetch(base + '/__push/sub', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ subscription }) })).status, 415);
    assert.equal((await fetch(base + '/__push/sub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'ftp://x/y', keys: subscription.keys } }) })).status, 400);
    assert.equal((await (await fetch(base + '/__push/sub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription }) })).json()).subs, 1);
    await new Promise(r => setTimeout(r, 250));                               // 감시가 지금 있는 것을 '본 것'으로 잡는다 — old 는 안 알림
    sheet('new1'); sheet('rep1', { report: 'merged' });
    appendChat(dir, 'infra', 'hero', 'hero 글은 안 알림'); appendChat(dir, 'infra', 'infra:fleet2', '세션 글도 안 알림 — 시트만');
    await until(() => got.length >= 2); await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(got.map(g => g.msg.title).sort(), ['📝 새 시트 · infra', '🔀 머지됨 · infra']);
    assert.deepEqual(got.filter(g => g.msg.url.startsWith('/sheet')).map(g => g.msg.url).sort(), ['/sheet.html?d=new1', '/sheet.html?d=rep1']);
    assert.ok(!got.some(g => g.msg.url.startsWith('/chat')));                // 채널 글은 안 알림
    assert.equal(got[0].h['content-encoding'], 'aes128gcm'); assert.match(got[0].h.authorization, /^vapid t=.+, k=/); assert.ok(got[0].h.ttl);
    reply = 410;                                                             // 폰에서 앱 지움 → 구독 빠짐
    const t = await (await fetch(base + '/__push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(t.sent[0].status, 410); assert.equal(readSubs(dir).length, 0);
    for (const f of ['/sw.js', '/push.js', '/manifest.webmanifest', '/icon-180.png']) assert.equal((await fetch(base + f)).status, 200, f);
    assert.match(await (await fetch(base + '/')).text(), /rel="manifest".*push\.js/);
  } finally { if (saved === undefined) delete process.env.REVIEW_SHEET_PUSH_MS; else process.env.REVIEW_SHEET_PUSH_MS = saved; await close(); fake.close(); }
});

test('chat say 는 읽음 처리하지 않는다 — 보내는 순간 막 온 hero 글을 놓치지 않게 (hero 2026-10-16)', () => {
  const dir = tmpDir();
  const env = { ...process.env, REVIEW_SHEET_INBOX: dir };
  execFileSync('node', [BIN, 'chat', 'new', 'root', '--owner', 'root:x'], { encoding: 'utf8', env });
  return import('../bin/review-sheet.mjs').then(({ appendChat }) => {
    appendChat(dir, 'root', 'hero', '방금 온 질문');
    execFileSync('node', [BIN, 'chat', 'say', 'root', '다른 답'], { encoding: 'utf8', env });
    assert.match(execFileSync('node', [BIN, 'chat', 'read', 'root'], { encoding: 'utf8', env }), /hero: 방금 온 질문/);
  });
});

test('CLI keeps sheet summaries on disk — unchanged data.js is not re-run', () => {
  const dir = tmpDir(), f = path.join(dir, 'example-data.js'), t = 1700000000;   // 정수 초 — utimes 왕복에서 mtime 이 안 흔들리게
  fs.utimesSync(f, t, t);
  const first = execFileSync('node', [BIN, 'ls', dir], { encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(dir, '.summary-cache.json')));
  fs.writeFileSync(f, 'throw new Error("must not be evaluated")');
  fs.utimesSync(f, t, t);
  assert.equal(execFileSync('node', [BIN, 'ls', dir], { encoding: 'utf8' }), first);
});

test('batch: 배치판 — 도메인별로 쌓고, 같은 규칙 두 번이면 이력 2줄, 같은 id 는 하나(새것이 이김), 상한 넘으면 오래된 것부터 잘림, /batch 에 main 채널 (#41)', async () => {
  const dir = tmpDir();
  const run = (id, at, extra = {}) => ({ id, status: 'done', verdict: 'look', line: '줄 ' + id, startedAt: at, endedAt: at, ms: 12, want: true, taken: null, waitingMin: 3,
    log: [{ level: 'look', code: 'X', text: '볼 것 ' + id }, { level: 'note' }], file: 'runs/' + id + '.json', ...extra });
  const view = runs => ({ format: 'pkch-batch-view/1', at: '2026-10-18T11:14:34.103Z', state: '~/s', tick: { at: '2026-10-18T11:14:00Z', ran: ['hourly-check'] },
    rules: [{ job: 'hourly-check', what: '매시 점검', verdicts: { clear: '없음', look: '볼 것' }, owner: 'pkch:main', draft: true, when: '매시', who_runs: '틱',
      on: { look: '관리가 처리' }, every_min: 60, next: null, health: 'weird', last: null, total: 1, runs }, { job: 'merge-check', owner: 'pkch:main', runs: [] }, { what: '이름 없음' }],
    others: [{ label: 'com.x.watch', pid: 12, status: '0' }] });
  const src = path.join(dir, 'in.json');
  fs.writeFileSync(src, JSON.stringify(view([run('a', '2026-10-18T10:00:00.000Z')])));
  assert.match(execFileSync('node', [BIN, 'batch', dir, src], { encoding: 'utf8' }), /규칙 2\t실행 1/);   // job 없는 규칙은 버림
  // 같은 규칙 두 번 → 이력 2줄 (stdin), 같은 id(a) 다시 오면 하나 — taken 붙은 새것
  execFileSync('node', [BIN, 'batch', dir, '-'], { input: JSON.stringify(view([run('b', '2026-10-18T11:00:00.000Z'), run('a', '2026-10-18T10:00:00.000Z', { taken: { by: 'pkch:관리', at: '2026-10-18T10:05:00Z', did: '처리함' } })])) });
  let b = JSON.parse(fs.readFileSync(path.join(dir, 'batch', 'pkch.json'), 'utf8'));
  assert.equal(b.domain, 'pkch');   // owner pkch:main → 도메인
  const hc = b.rules[0];
  assert.deepEqual(hc.runs.map(r => r.id), ['b', 'a']);   // 새것부터
  assert.equal(hc.runs[1].taken.by, 'pkch:관리');
  assert.equal(hc.health, 'none');
  assert.deepEqual(hc.runs[0].log.map(x => x.code), ['X']);   // text 없는 로그 줄은 버림
  // 상한: BATCH_KEEP(50) 넘으면 오래된 것부터
  const many = Array.from({ length: 55 }, (_, i) => run('m' + String(i).padStart(2, '0'), `2026-10-19T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`));
  execFileSync('node', [BIN, 'batch', dir, '-'], { input: JSON.stringify(view(many)) });
  b = JSON.parse(fs.readFileSync(path.join(dir, 'batch', 'pkch.json'), 'utf8'));
  assert.equal(b.rules[0].runs.length, 50);
  assert.equal(b.rules[0].runs[0].id, 'm54'); assert.equal(b.rules[0].runs.at(-1).id, 'm05');   // a·b·m00~m04 잘림
  // 다른 도메인은 따로 — --domain 으로 지정
  execFileSync('node', [BIN, 'batch', dir, '-', '--domain', 'spider'], { input: JSON.stringify({ format: 'pkch-batch-view/1', rules: [{ job: 'shell', runs: [run('s1', '2026-10-19T00:00:00Z')] }] }) });
  assert.match(execFileSync('node', [BIN, 'batch', dir], { encoding: 'utf8' }), /pkch\t규칙 2\t실행 50[\s\S]*spider\t규칙 1\t실행 1/);
  assert.throws(() => execFileSync('node', [BIN, 'batch', dir, '-'], { input: JSON.stringify({ rules: [{ job: 'x' }] }), stdio: 'pipe' }));   // 도메인 모름
  // 화면: /api/batch 에 그 도메인 main 채널, /batch 페이지, 받은편지함 링크
  execFileSync('node', [BIN, 'chat', 'new', 'pkch-main', '--owner', 'pkch:main'], { env: { ...process.env, REVIEW_SHEET_INBOX: dir } });
  const srv = await startServer(dir, 0);
  try {
    const j = await (await fetch(srv.base + '/api/batch')).json();
    assert.deepEqual(j.batches.map(x => [x.domain, x.chat]), [['pkch', 'pkch-main'], ['spider', null]]);
    assert.equal(j.batches[0].others[0].label, 'com.x.watch');
    const page = await (await fetch(srv.base + '/batch')).text();
    assert.match(page, /<title>배치<\/title>/); assert.match(page, /chat\.html\?c=/); assert.doesNotMatch(page, /<table/);
    assert.match(await (await fetch(srv.base + '/')).text(), /href="\/batch"/);
  } finally { await srv.close(); }
});

test('links: 받은편지함 위 줄 외부 링크 — 같은 label 덮어씀, url 비우면 지움, http(s)·/경로만, 목록 위 줄에 그림 (#47)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-links-'));
  const put = j => execFileSync('node', [BIN, 'links', dir, '-'], { input: JSON.stringify(j), encoding: 'utf8' });
  put({ links: [{ label: '뉴맥', url: '/q/board.html' }, { label: '큐', url: 'http://h:1/' }] });
  put({ links: [{ label: '큐', url: 'https://h:2/' }] });
  let l = JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8')).links;
  assert.deepEqual(l, [{ label: '뉴맥', url: '/q/board.html' }, { label: '큐', url: 'https://h:2/' }]);
  assert.throws(() => put({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }));
  assert.throws(() => put({ links: [{ label: 'x', url: '//evil/' }] }));
  put({ links: [{ label: '큐', url: '' }] });
  l = JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8')).links;
  assert.equal(l.length, 1);
  const { base, close } = await startServer(dir, 0);
  try {
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /<a class="rs-boardlink" href="\/q\/board.html" target="_blank" rel="noopener">뉴맥 →<\/a>/);
  } finally { await close(); }
});

test('탭 제목 접두어: REVIEW_SHEET_TAB_PREFIX 가 있으면 모든 HTML 탭 앞에 붙음 (#51)', async () => {
  const { tabPrefixed } = await import('../bin/review-sheet.mjs');
  assert.equal(tabPrefixed('<title>배치</title>', ''), '<title>배치</title>');
  assert.match(tabPrefixed('<title>배치</title><b>', '에어'), /^<title>배치<\/title><script>.*"에어 · ".*<\/script><b>$/);
  assert.doesNotMatch(tabPrefixed('<title>x</title>', '</script><i>'), /<\/script><i>/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tab-'));
  const { base, close } = await startServer(dir, 0);
  try {
    assert.doesNotMatch(await (await fetch(base + '/batch')).text(), /에어 · /);
    process.env.REVIEW_SHEET_TAB_PREFIX = '에어';
    for (const p of ['/', '/batch', '/board', '/chat.html', '/sheet.html']) assert.match(await (await fetch(base + p)).text(), /"에어 · "/, p);
    assert.doesNotMatch(await (await fetch(base + '/sheet.css')).text(), /에어/);
  } finally { delete process.env.REVIEW_SHEET_TAB_PREFIX; await close(); }
});
