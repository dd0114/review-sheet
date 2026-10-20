/* review-sheet 키보드 탐색 (hero 2026-10-19 "마우스 안 쓰고 큐 내려가며 빠르게 열기", 시트 root-hub-keyboard-1019 추천안).
   받은편지함(#rs-list 가 있는 페이지):
     ⌘J(Ctrl+J) = 커서 켜기/끄기(켜면 "답 기다리는 중" 첫 줄, 없으면 맨 위 — hero 2026-10-20 #144) · ↓/j ↑/k 한 줄씩 · Tab/⇧Tab 다음/이전 묶음 첫 줄 · g/G 맨 위/아래
     Enter/→ 열기 · ⌘/Ctrl+Enter 새 탭 · x = ✓ 확인(보고 시트) · f = 🔥 긴급 · Esc 커서 끄기
   5초 새로고침으로 목록이 다시 그려져도 커서는 같은 주소(href)를 따라가고, 그 줄이 없어지면(제출됨으로 내려감 등) 원래 자리 줄로.
   뒤로가기로 돌아오면 sessionStorage 에 둔 마지막 줄에서 다시 시작.
   채널·메모(#c-log/#m-log, hero 2026-10-20): ⌘J = 메시지 커서 켜기/끄기(켜면 맨 아래 최신, 입력칸 안에서도 — 켜면 입력칸 blur) · ↓/j ↑/k · g/G 처음/끝
     r = 그 메시지에 답장(↩ 와 같음 → 답장 띠 + 입력칸 포커스, 커서 끔) · Enter = 인용 있으면 원문으로 · 메모 Enter/Space = 복사 · Esc 커서 끄기
     입력칸 안에서는 ⌘J 말고 모든 키 무시. 3초 새로고침 뒤에도 커서는 같은 메시지 id 를 따라감.
   그 밖 페이지(시트·채널·메모): 커서 꺼진 상태에서 입력칸 밖 Esc = 받은편지함으로 (iframe 안·팝업 열림·녹음 중엔 안 함). 폰은 키보드가 없어 영향 없음. */
(() => {
  const KEY = 'rs-kb-cur';
  const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const list = document.getElementById('rs-list');

  if (!list) {   // 시트·채널·메모: Esc = 홈 (+ 채널·메모는 메시지 커서)
    if (window.top !== window) return;
    const log = document.getElementById('c-log') || document.getElementById('m-log');   // 채널 #c-log · 메모 #m-log
    const isJ = ev => (ev.metaKey || ev.ctrlKey) && (ev.key === 'j' || ev.key === 'J' || ev.code === 'KeyJ');
    let mcur = null, mIdx = 0;   // 커서가 있는 메시지 id (없으면 꺼짐)
    const msgs = () => log ? [...log.querySelectorAll('.c-msg')] : [];
    const idOf = el => el.id || el.dataset.id || '';
    const mpaint = scroll => {
      if (!log) return;
      log.querySelectorAll('.c-msg.rs-kb').forEach(x => x.classList.remove('rs-kb'));
      if (!mcur) return;
      const ms = msgs(); let i = ms.findIndex(el => idOf(el) === mcur);
      if (i < 0) { if (!ms.length) { mcur = null; return; } i = Math.min(mIdx, ms.length - 1); mcur = idOf(ms[i]); }   // 그 메시지가 사라짐 → 원래 자리
      mIdx = i; ms[i].classList.add('rs-kb');
      if (scroll) ms[i].scrollIntoView({ block: 'nearest' });
    };
    const mgo = i => { const ms = msgs(); if (!ms.length) return; i = Math.max(0, Math.min(ms.length - 1, i)); mcur = idOf(ms[i]); mIdx = i; mpaint(true); };
    const moff = () => { mcur = null; mpaint(false); };
    if (log) new MutationObserver(() => mpaint(false)).observe(log, { childList: true });   // 3초 새로고침으로 다시 그려도 같은 메시지 id 를 따라감
    document.addEventListener('keydown', ev => {
      if (ev.defaultPrevented || ev.altKey || ev.isComposing) return;
      const k = ev.key;
      if (log && isJ(ev)) {   // ⌘J = 커서 켜기/끄기 — 입력칸 안에서도 동작, 켜면 입력칸 blur
        ev.preventDefault();
        if (mcur) moff(); else { if (typing(document.activeElement)) document.activeElement.blur(); mgo(msgs().length - 1); }
        return;
      }
      if (typing(document.activeElement)) return;   // 글 쓰는 중엔 ⌘J 말고 모두 무시
      if (ev.metaKey || ev.ctrlKey) return;
      if (mcur) {
        const ms = msgs(), i = ms.findIndex(el => el.classList.contains('rs-kb')), m = ms[i];
        if (!m) return;
        if (k === 'ArrowDown' || k === 'j') { ev.preventDefault(); mgo(i + 1); }
        else if (k === 'ArrowUp' || k === 'k') { ev.preventDefault(); mgo(i - 1); }
        else if (k === 'g') { ev.preventDefault(); mgo(0); }
        else if (k === 'G') { ev.preventDefault(); mgo(ms.length - 1); }
        else if (k === 'r') { const b = m.querySelector('.c-re'); if (b) { ev.preventDefault(); moff(); b.click(); } }   // 답장 띠 + 입력칸 포커스 (메모는 ↩ 없음 → 무시)
        else if (k === 'Enter' || k === ' ') {
          const q = m.querySelector('.c-quote'), b = m.querySelector('.c-bubble[role=button]');   // 채널: 인용 → 원문으로 · 메모: 복사
          if (k === 'Enter' && q) { ev.preventDefault(); q.click(); const to = q.dataset.to; if (to && document.getElementById('m-' + to)) { mcur = 'm-' + to; mpaint(false); } }
          else if (b) { ev.preventDefault(); b.click(); }
        }
        else if (k === 'Escape') { ev.preventDefault(); moff(); }
        return;
      }
      if (k !== 'Escape') return;
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
    if (mod && (k === 'j' || k === 'J' || ev.code === 'KeyJ')) { ev.preventDefault(); if (on) { cur = null; save(); paint(false); } else start(); return; }   // ⌘J = 켜기/끄기
    if (mod && k !== 'Enter') return;
    if (!on) return;   // 커서가 꺼져 있으면 모든 키가 브라우저 기본 동작 그대로
    const rs = rows(), i = rs.findIndex(li => li.classList.contains('rs-kb'));
    if (k === 'ArrowDown' || k === 'j') { ev.preventDefault(); go(i + 1); }
    else if (k === 'ArrowUp' || k === 'k') { ev.preventDefault(); go(i - 1); }
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
