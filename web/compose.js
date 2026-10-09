/* review-sheet 입력칸 도우미 — chat · memo · sheet 공통 (hero 2026-10-09).
   ✕ 지우기: textarea 바로 다음 형제 <button class="rs-clear">. 글이 있을 때만 보이고(CSS :placeholder-shown),
     누르면 칸을 비우고 input 이벤트를 쏜다 → 초안 저장·높이 맞춤·시트 임시저장이 그대로 따라온다.
   ＋ 묶음: <button class="rs-plus" data-tray="<id>"> 가 사진·음성 줄을 열고 닫는다. 열림 상태는 이 기기에 기억. */
(() => {
  const KEY = 'rs-tray-open';
  const setTray = (btn, tray, open) => {
    tray.hidden = !open; btn.classList.toggle('on', open); btn.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (_) { /* private mode */ }
  };
  // 누를 때 입력칸 포커스를 뺏지 않게(폰 키보드가 내려갔다 올라오지 않게)
  document.addEventListener('mousedown', ev => { if (ev.target.closest && ev.target.closest('.rs-clear,.rs-plus')) ev.preventDefault(); });
  document.addEventListener('click', ev => {
    const c = ev.target.closest && ev.target.closest('.rs-clear');
    if (c) {
      const ta = c.previousElementSibling; if (!ta || !ta.matches('textarea')) return;
      ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return;
    }
    const p = ev.target.closest && ev.target.closest('.rs-plus');
    if (p) { const tray = document.getElementById(p.dataset.tray); if (tray) setTray(p, tray, tray.hidden); }
  });
  const init = () => {
    let open = false; try { open = localStorage.getItem(KEY) === '1'; } catch (_) { /* default closed */ }
    document.querySelectorAll('.rs-plus').forEach(p => { const t = document.getElementById(p.dataset.tray); if (t) setTray(p, t, open); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
