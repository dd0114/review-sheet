/* 웹 푸시 (hero 2026-10-16 "알림기능 리뷰시트에 만들래 사파리로 홈화면에 넣고 쓸거야") — 의존성 없이 node:crypto 만으로.
   VAPID(RFC 8292) 서명 + aes128gcm(RFC 8291) 암호화. 키·구독은 inbox/push/ 에만 둔다(구독 = 폰 브라우저가 준 주소+공개키). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
const pushDir = dir => path.join(dir, 'push');

/** VAPID 키 한 쌍 — 처음 부를 때 만들어 inbox/push/vapid.json(0600)에 둔다. publicKey = 65바이트 비압축 점(base64url). */
export function vapidKeys(dir) {
  const f = path.join(pushDir(dir), 'vapid.json');
  try { const k = JSON.parse(fs.readFileSync(f, 'utf8')); if (k.publicKey && k.privateKey) return k; } catch { /* first use */ }
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const k = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  fs.mkdirSync(pushDir(dir), { recursive: true }); fs.writeFileSync(f, JSON.stringify(k) + '\n', { mode: 0o600 });
  return k;
}
const privKey = k => { const p = unb64u(k.publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) }, format: 'jwk' }); };

/** Authorization 헤더 값 — aud = 푸시 서버 origin, 12시간짜리 ES256 JWT. sub 는 연락처(https: 또는 mailto:). */
export function vapidAuth(endpoint, k, sub, now = Date.now()) {
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: privKey(k), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${k.publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
/** RFC 8291 aes128gcm 본문 — keys = 구독의 { p256dh, auth }. salt·보내는 쪽 키는 시험용으로만 넘긴다. */
export function encrypt(payload, keys, { salt = crypto.randomBytes(16), asPrivate } = {}) {
  const ua = unb64u(keys.p256dh), auth = unb64u(keys.auth);
  const as = crypto.createECDH('prime256v1');
  if (asPrivate) as.setPrivateKey(unb64u(asPrivate)); else as.generateKeys();
  const asPub = as.getPublicKey();
  const ikm = hkdf(auth, as.computeSecret(ua), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

/* 구독 목록 — push/subs.json [{ endpoint, keys:{p256dh,auth}, origin, ua, at }] */
const subsFile = dir => path.join(pushDir(dir), 'subs.json');
export function readSubs(dir) { try { return JSON.parse(fs.readFileSync(subsFile(dir), 'utf8')) || []; } catch { return []; } }
function writeSubs(dir, subs) {
  fs.mkdirSync(pushDir(dir), { recursive: true });
  fs.writeFileSync(subsFile(dir) + '.tmp', JSON.stringify(subs, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(subsFile(dir) + '.tmp', subsFile(dir));
}
/** 폰 브라우저가 준 구독을 저장(같은 endpoint 는 갈아끼움). endpoint 는 https 만 — 시험용 127.0.0.1 http 는 허용. */
export function addSub(dir, sub, { origin = '', ua = '' } = {}) {
  const e = String(sub && sub.endpoint || ''), k = sub && sub.keys || {};
  let u; try { u = new URL(e); } catch { throw new Error('endpoint 가 URL 이 아님'); }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'))) throw new Error('endpoint 는 https 만');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(k.p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(k.auth || '')) throw new Error('keys(p256dh·auth) 형식이 아님');
  const subs = readSubs(dir).filter(s => s.endpoint !== e);
  subs.push({ endpoint: e, keys: { p256dh: k.p256dh, auth: k.auth }, origin: String(origin).slice(0, 200), ua: String(ua).slice(0, 200), at: new Date().toISOString() });
  writeSubs(dir, subs);
  return subs.length;
}
export function removeSub(dir, endpoint) { const subs = readSubs(dir), left = subs.filter(s => s.endpoint !== endpoint); if (left.length !== subs.length) writeSubs(dir, left); return left.length; }

/** 구독 전부에 알림 하나 — 404·410(폰에서 지움·만료)은 목록에서 뺀다. 결과 [{ endpoint 앞부분, status }] */
export async function pushAll(dir, msg) {
  const subs = readSubs(dir); if (!subs.length) return [];
  const k = vapidKeys(dir), body = JSON.stringify(msg), out = [];
  for (const s of subs) {
    let status = 0;
    try {
      const sub = process.env.REVIEW_SHEET_PUSH_SUB || (/^https:\/\//.test(s.origin) ? s.origin : 'mailto:review-sheet@localhost');
      const r = await fetch(s.endpoint, { method: 'POST', signal: AbortSignal.timeout(15e3), body: encrypt(body, s.keys),
        headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(s.endpoint, k, sub) } });
      status = r.status; await r.arrayBuffer().catch(() => {});
    } catch (e) { status = -1; }
    if (status === 404 || status === 410) removeSub(dir, s.endpoint);
    out.push({ endpoint: s.endpoint.slice(0, 40), status });
  }
  return out;
}
