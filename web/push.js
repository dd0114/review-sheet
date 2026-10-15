/* 🔔 폰 알림 켜기 (hero 2026-10-16) — 서비스워커를 걸고, #rs-push 자리에 버튼을 놓는다.
   iOS 사파리는 '홈 화면에 추가'로 연 앱에서만 알림을 켤 수 있다. 권한 요청은 버튼을 누를 때만(브라우저 규칙). */
(() => {
  const slot = document.getElementById('rs-push');
  const say = (t, btn) => { if (!slot) return; slot.innerHTML = ''; const b = document.createElement(btn ? 'button' : 'span'); if (btn) b.type = 'button'; b.className = 'rs-push'; b.textContent = t; slot.appendChild(b); return b; };
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { if (slot && /iPhone|iPad/.test(navigator.userAgent)) say('🔕 알림은 https 주소의 홈 화면 앱에서'); return; }
  const post = (u, j) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(j) });
  const key = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  navigator.serviceWorker.register('/sw.js').then(async reg => {
    if (!slot) return;
    if (!('PushManager' in window)) return say(/iPhone|iPad/.test(navigator.userAgent) ? '🔕 공유 → 홈 화면에 추가 → 그 앱에서 알림 켜기' : '🔕 이 브라우저는 알림 안 됨');
    const on = await reg.pushManager.getSubscription();
    if (on && Notification.permission === 'granted') {
      post('/__push/sub', { subscription: on.toJSON() });   // 서버가 목록을 잃었어도 다시 채운다
      const b = say('🔔 알림 켜짐 · 시험', true);
      b.onclick = async () => { b.disabled = true; const r = await post('/__push/test', {}).then(r => r.json()).catch(() => null); b.textContent = r && r.sent && r.sent.some(x => x.status >= 200 && x.status < 300) ? '🔔 보냈어요 — 곧 떠요' : '⚠ 못 보냄'; setTimeout(() => { b.disabled = false; b.textContent = '🔔 알림 켜짐 · 시험'; }, 4000); };
      return;
    }
    if (Notification.permission === 'denied') return say('🔕 알림 막힘 — 설정 > 알림에서 허용');
    const b = say('🔔 알림 켜기', true);
    b.onclick = async () => {
      b.disabled = true;
      try {
        if (await Notification.requestPermission() !== 'granted') { say('🔕 알림 허용 안 함'); return; }
        const { publicKey } = await fetch('/api/push').then(r => r.json());
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(publicKey) });
        const r = await post('/__push/sub', { subscription: sub.toJSON() });
        if (!r.ok) throw new Error(await r.text());
        say('🔔 알림 켜짐 · 시험', true).onclick = () => post('/__push/test', {});
        post('/__push/test', {});
      } catch (e) { b.disabled = false; b.textContent = '⚠ 다시 눌러 주세요 (' + String(e.message || e).slice(0, 40) + ')'; }
    };
  }).catch(() => {});
})();
(() => { const st = document.createElement('style');
  st.textContent = '.rs-push{font:inherit;font-size:13px;padding:4px 10px;border-radius:999px;border:1px solid #9CB3AA;background:#fff;color:#2F5D50;cursor:pointer;white-space:nowrap}span.rs-push{border:0;background:none;padding:0;color:#888}#rs-push{display:inline-block}';
  document.head.appendChild(st); })();
