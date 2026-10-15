// node --test review-sheet/test/   — server round-trip + read/markdown. No deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, loadSheet, readAnswers, renderMarkdown, dropHallucination } from '../bin/review-sheet.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'review-sheet.mjs');
const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'example-data.js');

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
  const run = (...a) => { try { return { out: execFileSync('node', [BIN, ...a], { encoding: 'utf8' }), code: 0 }; } catch (e) { return { out: e.stdout, code: e.status }; } };
  // first use starts the gate — answers saved before it are exempt
  assert.deepEqual(run('unassigned', dir), { out: '', code: 0 });
  const save = at => fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: at, answers: { 'A-1': { pick: '①' } } }));
  save(new Date().toISOString());
  let r = run('unassigned', dir);
  assert.equal(r.code, 5); assert.match(r.out, /^example\t배정없음\t/);
  assert.match(run('ls', dir).out, /^example\t.*\t배정없음$/m);
  assert.equal(run('unassigned', dir, '--prefix', 'zzz').code, 0);
  assert.match(run('assign', dir, 'example', '#12', 'proj:ws1').out, /배정 #12 → proj:ws1/);
  assert.deepEqual(run('unassigned', dir), { out: '', code: 0 });
  assert.doesNotMatch(run('ls', dir).out, /배정없음|답바뀜/);
  // hero changes the answer after assignment → reopens
  save(new Date(Date.now() + 60000).toISOString());
  assert.match(run('unassigned', dir).out, /^example\t답바뀜\t/);
});

test('stage: owner reports each step as an end-state tag on the sheet row; stalled steps surface in unassigned (hero 2026-10-13/14)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'answers'));
  const run = (...a) => { try { return { out: execFileSync('node', [BIN, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; } catch (e) { return { out: e.stdout + e.stderr, code: e.status }; } };
  run('unassigned', dir);                                   // gate starts now
  fs.writeFileSync(path.join(dir, 'answers', 'example.json'), JSON.stringify({ sheet: 'example', savedAt: new Date().toISOString(), answers: { 'A-1': { pick: '①' } } }));
  let r = run('stage', dir, 'example', '머지');
  assert.equal(r.code, 1); assert.match(r.out, /아직 배정 안 됨/);
  assert.equal(run('assign', dir, 'example', '#7', 'proj:ws1').code, 0);
  assert.match(run('stage', dir, 'example', 'merged', 'PR', '#9').out, /^example\t🔀 머지됨 — PR #9/);
  assert.equal(run('stage', dir, 'example', '반쯤').code, 1);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'assign', 'example.json'), 'utf8'));
  assert.deepEqual(a.stages.map(x => x.stage), ['배정', '머지']);
  assert.match(run('ls', dir).out, /\t머지 #7$/m);
  // backdate the last step → 멈춤 after 24h, not when final
  a.stages.at(-1).at = new Date(Date.now() - 30 * 3600e3).toISOString();
  fs.writeFileSync(path.join(dir, 'assign', 'example.json'), JSON.stringify(a));
  r = run('unassigned', dir);
  assert.equal(r.code, 5); assert.match(r.out, /^example\t멈춤\t/);
  assert.equal(run('unassigned', dir, '--hours', '48').code, 0);
  run('stage', dir, 'example', '라이브', '16:05 배포');
  assert.equal(run('unassigned', dir).code, 0);
  // end-state tag on the sheet row (hero 2026-10-14: 메인만? 배포 큐? 배포됨? 어드민 스위치? 언제?)
  assert.match(run('stage', dir, 'example', '라이브', '--off', '--eta', '다음 시즌', '스위치 켜면 공개').out, /^example\t🚀 배포됨 · 스위치 꺼짐 · 다음 시즌 공개 — 스위치 켜면 공개/);
  const { base, close } = await startServer(dir, 0);
  try {
    let inbox = await (await fetch(base + '/api/inbox')).json();
    let a = inbox.sheets.find(s => s.name === 'example').assign;
    assert.deepEqual([a.stage, a.off, a.eta, a.tag], ['라이브', true, '다음 시즌', '🚀 배포됨 · 스위치 꺼짐 · 다음 시즌 공개']);
    assert.equal(inbox.reports, undefined);
    assert.equal((await fetch(base + '/__report-ack?d=example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    run('stage', dir, 'example', '배포대기', '--eta', '15:00');
    inbox = await (await fetch(base + '/api/inbox')).json();
    assert.equal(inbox.sheets.find(s => s.name === 'example').assign.tag, '⏳ 배포 대기 · 15:00 예정');
    run('stage', dir, 'example', '머지');
    inbox = await (await fetch(base + '/api/inbox')).json();
    assert.equal(inbox.sheets.find(s => s.name === 'example').assign.tag, '🔀 머지됨');
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /rs-tag/); assert.doesNotMatch(html, /rs-report-h|오른쪽으로 밀면/);
  } finally { await close(); }
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
