// node --test review-sheet/test/   — server round-trip + read/markdown. No deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, loadSheet, readAnswers, renderMarkdown } from '../bin/review-sheet.mjs';

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
  } finally { await close(); }
});
