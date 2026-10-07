// node --test review-sheet/test/   — server round-trip + read/markdown. No deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startServer, loadSheet, readAnswers, renderMarkdown, readWorkers, WORKER_STATES } from '../bin/review-sheet.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'review-sheet.mjs');
const WORKERS_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workers.json');
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
  const { newChat, listChats, appendChat, readChatLog } = await import('../bin/review-sheet.mjs');
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
    c = listChats(dir)[0];
    assert.equal(c.unreadHero, 1); assert.equal(c.last.from, 'root:hub');
    // page: api shows seenAt ≥ hero message ts (읽음), and hero viewing clears unreadHero
    const j = await (await fetch(base + '/api/chat?c=root')).json();
    assert.ok(j.meta.seenAt >= j.messages[0].ts); assert.equal(j.messages.length, 2);
    await fetch(base + '/__chat?c=root', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(listChats(dir)[0].unreadHero, 0);
    // unknown channel → 404, bad id → 400/404
    assert.equal((await fetch(base + '/api/chat?c=nope')).status, 404);
    assert.equal((await fetch(base + '/__chat?c=..', { method: 'POST', body: '{}' })).status, 404);
    // ls via CLI + chat.html served
    assert.match(execFileSync('node', [BIN, 'chat', 'ls'], { encoding: 'utf8', env }), /^root\troot:hub\t2건/);
    assert.equal((await fetch(base + '/chat.html?c=root')).status, 200);
    assert.ok(readChatLog(dir, 'root').length === 2 && appendChat);
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

test('workers: no source → empty board, inbox/workers.json → file, $REVIEW_SHEET_WORKERS → proxied, dead URL → file + error', async () => {
  const fixture = JSON.parse(fs.readFileSync(WORKERS_FIXTURE, 'utf8'));
  const dir = tmpDir();
  const upDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-upstream-'));   // stands in for the fleet queue server
  fs.writeFileSync(path.join(upDir, 'board.json'), JSON.stringify({ ...fixture, workers: [{ ...fixture.workers[0], name: '프록시로 온 일꾼' }] }));
  const saved = process.env.REVIEW_SHEET_WORKERS;
  delete process.env.REVIEW_SHEET_WORKERS;
  const { base, close } = await startServer(dir, 0);
  const up = await startServer(upDir, 0);
  try {
    let b = await (await fetch(base + '/api/workers')).json();
    assert.deepEqual(b, { generatedAt: null, groups: [], workers: [], source: 'none' });

    fs.copyFileSync(WORKERS_FIXTURE, path.join(dir, 'workers.json'));
    b = await (await fetch(base + '/api/workers')).json();
    assert.equal(b.source, 'file');
    assert.deepEqual(b.workers, fixture.workers);
    assert.deepEqual(b.workers.map(w => w.state).sort(), [...WORKER_STATES].sort());
    assert.equal(b.groups[1].name, 'shop 방');

    process.env.REVIEW_SHEET_WORKERS = up.base + '/board.json';
    b = await (await fetch(base + '/api/workers')).json();
    assert.equal(b.source, 'url');
    assert.deepEqual(b.workers.map(w => w.name), ['프록시로 온 일꾼']);

    await up.close();   // upstream gone → the file again, with the reason
    b = await (await fetch(base + '/api/workers')).json();
    assert.equal(b.source, 'file');
    assert.equal(b.workers.length, 5);
    assert.match(b.error, /^url: /);

    fs.writeFileSync(path.join(dir, 'workers.json'), '{ broken');
    const bad = await readWorkers(dir, '');
    assert.equal(bad.source, 'none'); assert.match(bad.error, /^file: /);
  } finally {
    if (saved === undefined) delete process.env.REVIEW_SHEET_WORKERS; else process.env.REVIEW_SHEET_WORKERS = saved;
    await close();
  }
});

test('workers view: inbox carries the hidden strip + board script, /workers.html·css·js served, sprites optional (missing → 404, emoji fallback)', async () => {
  const dir = tmpDir();
  const { base, close } = await startServer(dir, 0);
  try {
    const index = await (await fetch(base + '/')).text();
    assert.match(index, /id="wb-strip"[^>]*hidden/);
    assert.match(index, /<script src="\/workers\.js">/);
    for (const f of ['/workers.html', '/workers.css', '/workers.js']) assert.equal((await fetch(base + f)).status, 200, f);
    assert.equal((await fetch(base + '/sprites/index.json')).status, fs.existsSync(path.join(path.dirname(BIN), '..', 'web', 'sprites', 'index.json')) ? 200 : 404);
    assert.equal((await fetch(base + '/sprites/..%2fsheet.css')).status, 404);
  } finally { await close(); }
});

test('workers card link: only http(s) becomes a clickable <a>, javascript:/data:/relative stay escaped text (AC6)', () => {
  const ctx = { window: {}, setInterval: () => 0 };
  vm.runInNewContext(fs.readFileSync(path.join(path.dirname(BIN), '..', 'web', 'workers.js'), 'utf8'), ctx);
  const { linkHtml } = ctx.window.WorkerBoard;
  assert.equal(linkHtml('https://github.com/x/y/pull/2'), '<a href="https://github.com/x/y/pull/2" target="_blank" rel="noopener">https://github.com/x/y/pull/2</a>');
  for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', '//evil.example', '/local', ' https://x']) {
    assert.ok(!linkHtml(u).includes('<a'), u);
  }
  assert.equal(linkHtml('data:text/html,<b>"x"</b>'), 'data:text/html,&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
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
