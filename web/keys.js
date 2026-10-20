/* review-sheet 키보드 탐색 (hero 2026-10-19 "마우스 안 쓰고 큐 내려가며 빠르게 열기", 시트 root-hub-keyboard-1019 추천안).
   받은편지함(#rs-list 가 있는 페이지):
     ↓/j 첫 누름 = 커서 켜기("답 기다리는 중" 첫 줄, 없으면 맨 위) · ↓/j ↑/k 한 줄씩 · Tab/⇧Tab 다음/이전 묶음 첫 줄 · g/G 맨 위/아래
     Enter/→ 열기 · ⌘/Ctrl+Enter 새 탭 · x = ✓ 확인(보고 시트) · f = 🔥 긴급 · Esc 커서 끄기
   5초 새로고침으로 목록이 다시 그려져도 커서는 같은 주소(href)를 따라가고, 그 줄이 없어지면(제출됨으로 내려감 등) 원래 자리 줄로.
   뒤로가기로 돌아오면 sessionStorage 에 둔 마지막 줄에서 다시 시작.
   그 밖 페이지(시트·채널·메모): 입력칸 밖에서 Esc = 받은편지함으로 (iframe 안·팝업 열림·녹음 중엔 안 함). 폰은 키보드가 없어 영향 없음. */
(() => {
  const KEY = 'rs-kb-cur';
  const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const list = document.getElementById('rs-list');

  if (!list) {   // 시트·채널·메모: Esc = 홈
    if (window.top !== window) return;
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing) return;
      if (typing(document.activeElement)) return;
      const pop = document.getElementById('rs-pop'); if (pop && !pop.hidden) return;   // 시트 팝업은 Esc 가 먼저 닫는다
      if (document.querySelector('.rs-mic[data-state=rec]')) return;
      location.href = '/';
    });
    return;
  }

  let cur = null;   // 커서가 있는 줄의 href (없으면 꺼짐)
  let lastIdx = 0;
  try { cur = sessionStorage.getItem(KEY); } catch (_) { /* private mode */ }
  const rows = () => [...list.querySelectorAll('ul.rs-index > li > a[href]')].map(a => a.closest('li'));
  const hrefOf = li => li.querySelector('a[href]').getAttribute('href');
  const save = () => { try { cur ? sessionStorage.setItem(KEY, cur) : sessionStorage.removeItem(KEY); } catch (_) {} };
  const paint = scroll => {
    const rs = rows();
    list.querySelectorAll('.rs-kb').forEach(x => x.classList.remove('rs-kb'));
    if (!cur) return;
    let i = rs.findIndex(li => hrefOf(li) === cur);
    if (i < 0) { if (!rs.length) return; i = Math.min(lastIdx, rs.length - 1); cur = hrefOf(rs[i]); save(); }   // 그 줄이 사라짐 → 원래 자리
    lastIdx = i; rs[i].classList.add('rs-kb');
    if (scroll) rs[i].scrollIntoView({ block: 'nearest' });
  };
  const go = i => { const rs = rows(); if (!rs.length) return; i = Math.max(0, Math.min(rs.length - 1, i)); cur = hrefOf(rs[i]); lastIdx = i; save(); paint(true); };
  const start = () => {   // 첫 줄 = "답 기다리는 중" 묶음의 첫 시트, 없으면 맨 위
    const rs = rows(), h = [...list.querySelectorAll('h2')].find(x => x.textContent.startsWith('답 기다리는 중'));
    const ul = h && h.nextElementSibling, first = ul && ul.querySelector('li > a[href]');
    go(first ? rs.indexOf(first.closest('li')) : 0);
  };
  const groupJump = dir => {   // 다음/이전 <ul> 묶음의 첫 줄
    const rs = rows(), i = rs.findIndex(li => li.classList.contains('rs-kb')); if (i < 0) return start();
    const uls = [...new Set(rs.map(li => li.parentElement))], g = uls.indexOf(rs[i].parentElement);
    const t = uls[Math.max(0, Math.min(uls.length - 1, g + dir))];
    go(rs.indexOf(t.querySelector('li')));
  };
  new MutationObserver(() => paint(false)).observe(list, { childList: true });   // 5초 새로고침 뒤 다시 칠함
  paint(true);

  document.addEventListener('keydown', ev => {
    if (ev.defaultPrevented || ev.altKey || ev.isComposing || typing(document.activeElement)) return;
    const on = !!list.querySelector('.rs-kb'), k = ev.key, mod = ev.metaKey || ev.ctrlKey;
    if (mod && k !== 'Enter') return;
    const rs = rows(), i = rs.findIndex(li => li.classList.contains('rs-kb'));
    if (k === 'ArrowDown' || k === 'j') { ev.preventDefault(); on ? go(i + 1) : start(); return; }
    if (!on) return;   // 아래 키들은 커서가 켜져 있을 때만 — 꺼져 있으면 브라우저 기본 동작 그대로
    if (k === 'ArrowUp' || k === 'k') { ev.preventDefault(); go(i - 1); }
    else if (k === 'Tab') { ev.preventDefault(); groupJump(ev.shiftKey ? -1 : 1); }
    else if (k === 'g') { ev.preventDefault(); go(0); }
    else if (k === 'G') { ev.preventDefault(); go(rs.length - 1); }
    else if (k === 'Enter' || k === 'ArrowRight') {
      ev.preventDefault(); const a = rs[i].querySelector('a[href]');
      if (mod) window.open(a.href, '_blank', 'noopener'); else location.href = a.href;
    }
    else if (k === 'x') { const b = rs[i].querySelector('.rs-check'); if (b) { ev.preventDefault(); b.click(); } }
    else if (k === 'f') { const b = rs[i].querySelector('.rs-flag'); if (b) { ev.preventDefault(); b.click(); } }
    else if (k === 'Escape') { ev.preventDefault(); cur = null; save(); paint(false); }
  });
})();
