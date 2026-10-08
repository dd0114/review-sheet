/* review-sheet 🎤 음성 입력 — 탭 = 녹음 시작, 다시 탭(또는 다른 칸 탭) = 멈춤 → POST /api/stt (로컬 whisper.cpp) → 텍스트를 커서 위치에 끼운다.
   말하는 동안: 2~3초마다 쌓인 녹음을 ?live=1&from=<이미 적은 초> 로 보내 회색 말풍선에 조각을 붙인다(빠른 greedy).
   멈추면 전체를 한 번 더 깨끗이 적어 칸에 넣고 말풍선은 지운다 (hero 2026-10-08 ②).
   쓰는 법: <button type="button" class="rs-mic" data-for="<textarea id>"> 또는 textarea 의 바로 옆 형제 버튼.
   폰 마이크는 보안 컨텍스트(HTTPS · localhost)에서만 열린다 — 폰은 tailscale serve 의 https 주소로 연다. */
(function () {
  'use strict';
  const MAX_SEC = 120;
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const LIVE_MS = 2500;
  let cur = null;   // { btn, ta, rec, stream, chunks, timer, t0, live }

  const toast = msg => {
    let el = document.getElementById('rs-mic-toast');
    if (!el) { el = document.createElement('div'); el.id = 'rs-mic-toast'; el.className = 'rs-mic-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 4000);
  };
  const setState = (btn, state, label) => {
    btn.dataset.state = state;
    btn.textContent = label || { idle: '🎤', rec: '⏹', busy: '…' }[state];
    btn.setAttribute('aria-label', { idle: '음성 입력', rec: '녹음 멈추고 전사', busy: '전사 중' }[state]);
  };
  const targetOf = btn => (btn.dataset.for && document.getElementById(btn.dataset.for)) ||
    (btn.previousElementSibling && btn.previousElementSibling.matches('textarea,input') ? btn.previousElementSibling : null) ||
    (btn.parentElement && btn.parentElement.querySelector('textarea'));

  /** insert at the caret (remembered before the tap stole focus), with a space if it would glue onto a word */
  const insert = (ta, text, at) => {
    const v = ta.value, s = at ? at[0] : v.length, e = at ? at[1] : v.length;
    const pre = v.slice(0, s) && !/\s$/.test(v.slice(0, s)) ? ' ' : '';
    const post = v.slice(e) && !/^\s/.test(v.slice(e)) ? ' ' : '';
    ta.value = v.slice(0, s) + pre + text + post + v.slice(e);
    const caret = s + pre.length + text.length;
    ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // drafts · autosize
    if (ta.scrollHeight > ta.clientHeight) ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';   // show what was heard
  };

  /** 말하는 중 미리보기 말풍선 — 입력칸 바로 위에 떠서 레이아웃을 안 건드린다 */
  const bubble = (me, text) => {
    let el = me.liveEl;
    if (!el) { el = me.liveEl = document.createElement('div'); el.className = 'rs-mic-live'; el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = text;
    const r = me.ta.getBoundingClientRect(), h = el.offsetHeight;
    el.style.left = Math.max(8, r.left) + 'px';
    el.style.width = Math.min(r.width || 320, window.innerWidth - 16) + 'px';
    el.style.top = (r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6) + 'px';
  };
  const unbubble = me => { if (me.liveEl) { me.liveEl.remove(); me.liveEl = null; } };
  const livePeek = async me => {
    const L = me.live;
    if (L.busy || cur !== me || me.rec.state !== 'recording' || !me.chunks.length) return;
    if ((Date.now() - me.t0) / 1000 - L.from < 2) return;
    L.busy = true;
    try {
      const blob = new Blob(me.chunks.slice(), { type: (me.rec.mimeType || 'audio/webm').split(';')[0] });
      const r = await fetch('/api/stt?live=1&from=' + L.from, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (r.ok && !L.done) {
        if (typeof j.end === 'number' && j.end > L.from) L.from = j.end;
        if (j.text) L.text = (L.text ? L.text + ' ' : '') + j.text;
        bubble(me, (L.text || '듣는 중…') + (me.rec.state === 'recording' ? ' …' : ''));
      }
    } catch (_) { /* 미리보기는 실패해도 그만 — 최종 전사가 있다 */ }
    finally { L.busy = false; }
  };

  const stop = () => { if (cur && cur.rec.state !== 'inactive') cur.rec.stop(); };

  const start = async btn => {
    const ta = targetOf(btn); if (!ta) return;
    const at = document.activeElement === ta || ta._rsSel ? (ta._rsSel || [ta.selectionStart, ta.selectionEnd]) : null;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { toast('마이크 권한이 없다 — ' + (err && err.name === 'NotAllowedError' ? '브라우저 설정에서 허용' : (err && err.message || err))); return; }
    const type = pickType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const me = cur = { btn, ta, rec, stream, chunks: [], t0: Date.now(), timer: null, live: { text: '', from: 0, busy: false, done: false }, liveEl: null };
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) me.chunks.push(ev.data); };
    rec.onstop = async () => {
      clearInterval(me.timer); clearInterval(me.liveTimer); stream.getTracks().forEach(t => t.stop());
      if (cur === me) cur = null;
      const blob = new Blob(me.chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] });
      if (!blob.size || Date.now() - me.t0 < 400) { me.live.done = true; unbubble(me); setState(btn, 'idle'); return; }
      setState(btn, 'busy'); btn.disabled = true;
      if (me.liveEl) bubble(me, (me.live.text || '') + ' — 다듬는 중…');
      try {
        const r = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        if (j.text) insert(ta, j.text, at); else toast('들린 말이 없다');
      } catch (err) { toast('전사 실패 — ' + err.message); }
      finally { me.live.done = true; unbubble(me); btn.disabled = false; setState(btn, 'idle'); }
    };
    rec.start(1000);
    setState(btn, 'rec', '⏹ 0');
    bubble(me, '듣는 중…');
    fetch('/api/stt?warm=1').catch(() => {});   // 상주 받아쓰기 모델을 미리 올려 둔다
    me.liveTimer = setInterval(() => livePeek(me), LIVE_MS);
    me.timer = setInterval(() => {
      const s = Math.round((Date.now() - me.t0) / 1000);
      btn.textContent = '⏹ ' + s;
      if (s >= MAX_SEC) stop();
    }, 500);
  };

  // remember each textarea's caret, since tapping the mic button blurs it (phones especially)
  document.addEventListener('selectionchange', () => {
    const a = document.activeElement;
    if (a && a.tagName === 'TEXTAREA') a._rsSel = [a.selectionStart, a.selectionEnd];
  });
  document.addEventListener('click', ev => {
    const btn = ev.target.closest && ev.target.closest('.rs-mic'); if (!btn) return;
    ev.preventDefault();
    if (!supported) { toast(window.isSecureContext ? '이 브라우저는 녹음을 지원하지 않는다' : '마이크는 HTTPS 에서만 — tailscale https 주소로 열 것'); return; }
    if (btn.disabled) return;
    if (cur && cur.btn === btn) return stop();
    if (cur) stop();
    start(btn);
  });
  // 다른 칸·버튼을 누르면 정지 버튼 없이도 멈추고 전사 → 원래 칸에 들어간다 (hero 2026-10-08: 기본 마이크처럼).
  // click 만 본다 — pointerdown 은 폰 스크롤에도 떠서 녹음이 끊긴다.
  const other = el => cur && el && !cur.btn.contains(el) && el !== cur.ta;
  document.addEventListener('focusin', ev => { if (other(ev.target) && ev.target.matches('input,textarea,select,[contenteditable]')) stop(); });
  document.addEventListener('click', ev => {
    const el = ev.target.closest && ev.target.closest('button,a,input,textarea,select,label,[role=button],[contenteditable]');
    if (other(el) && !el.closest('.rs-mic')) stop();
  }, true);
  const follow = () => { if (cur && cur.liveEl) bubble(cur, cur.liveEl.textContent); };
  window.addEventListener('scroll', follow, true); window.addEventListener('resize', follow);
  // pointerdown on the button must not steal the caret from the textarea on desktop
  document.addEventListener('mousedown', ev => { if (ev.target.closest && ev.target.closest('.rs-mic')) ev.preventDefault(); });
  window.RSMic = { supported, stop };
}());
