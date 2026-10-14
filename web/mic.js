/* review-sheet 🎤 음성 입력 — 탭 = 녹음 시작, 다시 탭(또는 다른 칸 탭) = 멈춤 → POST /api/stt (로컬 whisper.cpp) → 텍스트를 커서 위치에 끼운다.
   말하는 동안: 1.5초마다 쌓인 녹음 전체를 ?live=1 로 보내 입력칸의 그 자리를 새로 적은 글로 바꾼다(빠른 greedy, 단어장 없이).
   멈추면 전체를 한 번 더 깨끗이 적어 같은 자리를 덮어쓴다. 예전엔 따로 뜬 회색 말풍선에 썼는데 정지 버튼을 덮고
   칸이 둘로 보여 입력칸에 바로 쓰기로 (hero 2026-10-14).
   쓰는 법: <button type="button" class="rs-mic" data-for="<textarea id>"> 또는 textarea 의 바로 옆 형제 버튼.
   폰 마이크는 보안 컨텍스트(HTTPS · localhost)에서만 열린다 — 폰은 tailscale serve 의 https 주소로 연다.
   ＋ 묶음 안의 🎤 로 녹음하면 ＋ 자리가 빨간 ⏹ 가 된다 — 말풍선이 묶음 줄의 ⏹ 를 덮어 정지 버튼을 못 찾았다 (hero 2026-10-14).
   단축키 ⌥M(Alt+M) = 녹음 시작/끝 — 지금 쓰는 칸의 🎤, 없으면 화면 첫 🎤. */
(function () {
  'use strict';
  const MAX_SEC = 120;
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const LIVE_MS = 1500;
  let cur = null;   // { btn, ta, rec, stream, chunks, timer, t0, live }

  const toast = msg => {
    let el = document.getElementById('rs-mic-toast');
    if (!el) { el = document.createElement('div'); el.id = 'rs-mic-toast'; el.className = 'rs-mic-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 4000);
  };
  const setState = (btn, state, label) => {
    btn.dataset.state = state;
    btn.textContent = label || (state === 'idle' && btn.dataset.idle) || { idle: '🎤', rec: '⏹', busy: '…' }[state];
    btn.setAttribute('aria-label', { idle: '음성 입력', rec: '녹음 멈추고 전사', busy: '전사 중' }[state]);
    btn.title = { idle: '음성 입력 (⌥M)', rec: '녹음 멈추기 (⌥M)', busy: '전사 중' }[state];
  };
  // ＋ 묶음 안의 🎤 → 녹음 중엔 그 ＋ 가 정지 버튼 노릇을 한다(누르면 다른 버튼 누름과 같아 멈춤)
  const plusOf = btn => { const t = btn.closest('[id]'); return t && t.hidden !== undefined && document.querySelector('.rs-plus[data-tray="' + t.id + '"]'); };
  const plusRec = (me, label) => {
    const p = me.plus; if (!p) return;
    if (label) { if (!p.dataset.rec) p.dataset.idle = p.textContent; p.dataset.rec = '1'; p.classList.add('rec'); p.textContent = label; p.title = '녹음 멈추기 (⌥M)'; }
    else { delete p.dataset.rec; p.classList.remove('rec'); p.textContent = p.dataset.idle || '＋'; p.title = ''; }
  };
  const targetOf = btn => (btn.dataset.for && document.getElementById(btn.dataset.for)) ||
    (btn.previousElementSibling && btn.previousElementSibling.matches('textarea,input') ? btn.previousElementSibling : null) ||
    (btn.parentElement && btn.parentElement.querySelector('textarea')) ||
    (btn.closest('.v-q,.c-bar') && btn.closest('.v-q,.c-bar').querySelector('textarea'));   // 첨부 줄·＋ 묶음 안의 🎤

  /** insert at the caret (remembered before the tap stole focus), with a space if it would glue onto a word */
  const insert = (ta, text, at, base) => {
    const v = base != null ? base : ta.value, s = at ? at[0] : v.length, e = at ? at[1] : v.length;
    const pre = v.slice(0, s) && !/\s$/.test(v.slice(0, s)) ? ' ' : '';
    const post = v.slice(e) && !/^\s/.test(v.slice(e)) ? ' ' : '';
    ta.value = v.slice(0, s) + pre + text + post + v.slice(e);
    const caret = s + pre.length + text.length;
    ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // drafts · autosize
    if (ta.scrollHeight > ta.clientHeight) ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';   // show what was heard
  };

  /** 말하는 중 — 녹음 시작 때의 칸 내용(base) 그 자리에 지금까지 들린 말을 끼워 칸을 다시 쓴다 */
  const liveWrite = (me, text) => {   // 포커스는 안 옮긴다 — 폰에서 말할 때마다 키보드가 튀어나오지 않게
    const v = me.base, s = me.at ? me.at[0] : v.length, e = me.at ? me.at[1] : v.length;
    const pre = v.slice(0, s) && !/\s$/.test(v.slice(0, s)) ? ' ' : '', post = v.slice(e) && !/^\s/.test(v.slice(e)) ? ' ' : '';
    me.ta.value = v.slice(0, s) + pre + text + post + v.slice(e);
    me.ta.dispatchEvent(new Event('input', { bubbles: true }));
    me.ta.scrollTop = me.ta.scrollHeight;
  };
  const restore = me => { me.ta.value = me.base; me.ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const livePeek = async me => {
    const L = me.live;
    if (L.busy || cur !== me || me.rec.state !== 'recording' || !me.chunks.length) return;
    const sec = (Date.now() - me.t0) / 1000;
    if (sec < 1.5 || sec - L.at < 1) return;
    L.busy = true;
    try {
      const blob = new Blob(me.chunks.slice(), { type: (me.rec.mimeType || 'audio/webm').split(';')[0] });
      L.at = sec;
      // 매번 처음부터 다시 적는다 — 조각을 이어 붙이면 경계에서 단어가 잘린다(‘마이 | 크’). 상주 모델이라 1분 말도 ~2초.
      const r = await fetch('/api/stt?live=1', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (r.ok && !L.done && me.rec.state === 'recording') {   // 멈춘 뒤 늦게 온 조각은 버린다(‘다듬는 중’ 덮어쓰기 방지)
        if (j.text) { L.text = j.text; liveWrite(me, j.text); }
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
    const me = cur = { btn, ta, rec, stream, chunks: [], t0: Date.now(), timer: null, live: { text: '', at: 0, busy: false, done: false }, plus: plusOf(btn), base: ta.value, at };
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) me.chunks.push(ev.data); };
    rec.onstop = async () => {
      clearInterval(me.timer); clearInterval(me.liveTimer); stream.getTracks().forEach(t => t.stop());
      if (cur === me) cur = null;
      plusRec(me, null);
      const blob = new Blob(me.chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] });
      if (!blob.size || Date.now() - me.t0 < 400) { me.live.done = true; if (me.live.text) restore(me); setState(btn, 'idle'); return; }
      setState(btn, 'busy'); btn.disabled = true;
      try {
        const r = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        if (j.text) insert(ta, j.text, at, me.base); else { restore(me); toast('들린 말이 없다'); }
      } catch (err) { toast('전사 실패 — ' + err.message + (me.live.text ? ' (칸의 글은 미리 들은 것)' : '')); }
      finally { me.live.done = true; btn.disabled = false; setState(btn, 'idle'); }
    };
    rec.start(1000);
    setState(btn, 'rec', '⏹ 0'); plusRec(me, '⏹');
    fetch('/api/stt?warm=1').catch(() => {});   // 상주 받아쓰기 모델을 미리 올려 둔다
    me.liveTimer = setInterval(() => livePeek(me), LIVE_MS);
    me.timer = setInterval(() => {
      const s = Math.round((Date.now() - me.t0) / 1000);
      btn.textContent = '⏹ ' + s; plusRec(me, '⏹');
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
  // pointerdown on the button must not steal the caret from the textarea on desktop
  document.addEventListener('mousedown', ev => { if (ev.target.closest && ev.target.closest('.rs-mic')) ev.preventDefault(); });
  // ⌥M = 녹음 시작/끝 (mac 은 ⌥M 이 'µ' 를 치므로 key 가 아니라 code 로 본다)
  document.addEventListener('keydown', ev => {
    if (!ev.altKey || ev.metaKey || ev.ctrlKey || ev.code !== 'KeyM' || ev.repeat) return;
    ev.preventDefault();
    if (cur) return stop();
    const a = document.activeElement, all = [...document.querySelectorAll('.rs-mic')];
    const btn = all.find(b => a && targetOf(b) === a) || all[0];
    if (!btn || btn.disabled) return;
    if (!supported) { toast(window.isSecureContext ? '이 브라우저는 녹음을 지원하지 않는다' : '마이크는 HTTPS 에서만 — tailscale https 주소로 열 것'); return; }
    start(btn);
  });
  window.RSMic = { supported, stop };
}());
