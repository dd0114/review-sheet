/* review-sheet 🎤 음성 입력 — 탭 = 녹음 시작, 다시 탭 = 멈춤 → POST /api/stt (로컬 whisper.cpp) → 텍스트를 커서 위치에 끼운다.
   쓰는 법: <button type="button" class="rs-mic" data-for="<textarea id>"> 또는 textarea 의 바로 옆 형제 버튼.
   폰 마이크는 보안 컨텍스트(HTTPS · localhost)에서만 열린다 — 폰은 tailscale serve 의 https 주소로 연다. */
(function () {
  'use strict';
  const MAX_SEC = 120;
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  let cur = null;   // { btn, rec, stream, chunks, timer, t0 }

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

  const stop = () => { if (cur && cur.rec.state !== 'inactive') cur.rec.stop(); };

  const start = async btn => {
    const ta = targetOf(btn); if (!ta) return;
    const at = document.activeElement === ta || ta._rsSel ? (ta._rsSel || [ta.selectionStart, ta.selectionEnd]) : null;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { toast('마이크 권한이 없다 — ' + (err && err.name === 'NotAllowedError' ? '브라우저 설정에서 허용' : (err && err.message || err))); return; }
    const type = pickType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const me = cur = { btn, rec, stream, chunks: [], t0: Date.now(), timer: null };
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) me.chunks.push(ev.data); };
    rec.onstop = async () => {
      clearInterval(me.timer); stream.getTracks().forEach(t => t.stop());
      if (cur === me) cur = null;
      const blob = new Blob(me.chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] });
      if (!blob.size || Date.now() - me.t0 < 400) { setState(btn, 'idle'); return; }
      setState(btn, 'busy'); btn.disabled = true;
      try {
        const r = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        if (j.text) insert(ta, j.text, at); else toast('들린 말이 없다');
      } catch (err) { toast('전사 실패 — ' + err.message); }
      finally { btn.disabled = false; setState(btn, 'idle'); }
    };
    rec.start(1000);
    setState(btn, 'rec', '⏹ 0');
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
  // pointerdown on the button must not steal the caret from the textarea on desktop
  document.addEventListener('mousedown', ev => { if (ev.target.closest && ev.target.closest('.rs-mic')) ev.preventDefault(); });
  window.RSMic = { supported, stop };
}());
