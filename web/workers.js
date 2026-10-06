/* review-sheet — 일꾼 보드. GET /api/workers 문서(SKILL.md §일꾼 보드)를 방별·상태순 목록으로 그린다.
 * 받은편지함 상단 토글과 /workers.html(크게 보기)이 같이 쓴다. 5초 폴링은 페이지 쪽.
 * 모습: web/sprites/index.json 에 종이 있으면 워커 id 해시로 종을 고정 배정해 스프라이트시트 프레임을 돌린다.
 *       없으면 종별 이모지 폴백. 스프라이트 규격: sprites/README.md. */
(function () {
  const m = 60e3, h = 3600e3, d = 24 * h;
  const ORDER = { waiting_input: 0, working: 1, delegating: 2, reply_ready: 3, gone: 4 };
  const ST = { waiting_input: ['🔴', '입력 필요', '❓'], working: ['🟡', '하는 중', '🔨'], delegating: ['🟠', '위임 중', '👥'],
    reply_ready: ['🟢', '답 와있음', '📄'], gone: ['⚪', '퇴근', ''] };
  const UNKNOWN = ['⚫', '알 수 없음', ''];
  // 스프라이트 없을 때 종별 자리표시 — 종 이름은 sprites/index.json 이 있으면 그쪽 순서를 쓴다.
  const EMOJI = { peon: '👷', mechanic: '🧑‍🔧', dwarf: '🧔', farmer: '🧑‍🌾', clerk: '🧑‍💼', wizard: '🧙', robot: '🤖', chef: '🧑‍🍳' };
  let species = Object.keys(EMOJI), sheets = {};   // sheets[sp] = { image, size:[w,h], frame:[w,h], fps, states:{state:[[x,y],…]} }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = ms => ms < m ? '방금' : ms < h ? Math.round(ms / m) + '분' : ms < d ? Math.round(ms / h) + '시간' : Math.round(ms / d) + '일';
  const since = iso => { const t = Date.parse(iso); return isNaN(t) ? null : Math.max(0, Date.now() - t); };
  const hash = s => { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };   // FNV-1a
  const speciesOf = id => species[hash(id) % species.length];
  const st = w => ST[w.state] || UNKNOWN;
  const live = w => w.state !== 'gone';

  async function loadSprites(base) {
    try {
      const r = await fetch(base + 'index.json', { cache: 'no-store' }); if (!r.ok) return;
      const idx = await r.json(); if (!Array.isArray(idx.species) || !idx.species.length) return;
      const got = {};
      await Promise.all(idx.species.map(async sp => {
        try { const j = await (await fetch(base + sp + '.json', { cache: 'no-store' })).json(); j.image = base + (j.image || sp + '.png'); got[sp] = j; } catch (_) {}
      }));
      species = idx.species; sheets = got;
    } catch (_) {}
  }

  // 한 칸 그리기: 스프라이트가 있으면 <i class="spr"> (프레임은 tick 이 돌린다), 없으면 이모지.
  function fig(w, px) {
    const sp = speciesOf(w.id), sh = sheets[sp], frames = sh && sh.states && (sh.states[w.state] || sh.states.working);
    if (!frames || !frames.length) return { html: EMOJI[sp] || '👷', spr: false };
    const k = px / sh.frame[0], [x, y] = frames[0];
    return { spr: true, html: '<i class="spr" data-sp="' + esc(sp) + '" data-st="' + esc(w.state) + '" style="background-image:url(\'' + esc(sh.image) + '\');' +
      'background-size:' + sh.size[0] * k + 'px ' + sh.size[1] * k + 'px;background-position:' + (-x * k) + 'px ' + (-y * k) + 'px"></i>' };
  }
  let tickN = 0;
  setInterval(() => {   // 스프라이트 프레임 넘기기 — 4fps 기본, 종마다 fps 지정 가능
    tickN++;
    for (const el of document.querySelectorAll('i.spr')) {
      const sh = sheets[el.dataset.sp]; if (!sh) continue;
      const frames = sh.states[el.dataset.st] || sh.states.working; if (!frames || frames.length < 2) continue;
      const every = Math.max(1, Math.round(8 / (sh.fps || 4)));
      if (tickN % every) continue;
      const k = el.clientWidth / sh.frame[0], [x, y] = frames[(tickN / every | 0) % frames.length];
      el.style.backgroundPosition = (-x * k) + 'px ' + (-y * k) + 'px';
    }
  }, 125);

  function tile(w) {
    const s = st(w), f = fig(w, 44), z = w.load && w.load.zone || 'ok', pct = w.load && typeof w.load.pct === 'number' ? Math.max(0, Math.min(100, w.load.pct)) : null;
    const inState = since(w.stateSince), born = since(w.createdAt);
    return '<div class="wk" data-id="' + esc(w.id) + '" data-state="' + esc(w.state) + '" data-zone="' + esc(z) + '">' +
      '<div class="fig' + (f.spr ? ' has-spr' : '') + '">' + f.html + (s[2] ? '<span class="badge">' + s[2] + '</span>' : '') + '</div><div class="body">' +
      '<div class="nm">' + esc(w.name || w.id) + '</div>' +
      '<div class="st">' + s[0] + ' <b>' + s[1] + '</b> ' + (inState == null ? '' : ago(inState) + (live(w) ? '째' : '')) + '</div>' +
      '<div class="age">' + (born == null ? '' : '🐣 ' + ago(born) + ' 전 생성') + (live(w) && pct != null ? ' · ctx ' + pct + '%' : '') + '</div>' +
      (live(w) && pct != null ? '<div class="load"><i style="width:' + pct + '%"></i></div>' : '') + '</div></div>';
  }

  function render(el, board) {
    const ws = (board && board.workers) || [];
    const groups = ((board && board.groups) || []).slice();
    for (const w of ws) if (!groups.some(g => g.id === w.group)) groups.push({ id: w.group, name: w.group ? w.group + ' 방' : '기타' });
    let out = '';
    for (const g of groups) {
      const mine = ws.filter(w => w.group === g.id || (!w.group && !g.id))
        .sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (Date.parse(a.stateSince) || 0) - (Date.parse(b.stateSince) || 0));
      if (!mine.length) continue;
      const gone = mine.filter(w => !live(w)).length;
      out += '<div class="wb-room"><h3>🏗 ' + esc(g.name || g.id) + ' <span class="n">' + (mine.length - gone) + '명' + (gone ? ' · 퇴근 ' + gone : '') + '</span></h3>' +
        '<div class="wb-grid">' + mine.map(tile).join('') + '</div></div>';
    }
    el.innerHTML = out || '<div class="wb-empty">지금 일하는 일꾼 없음</div>';
    el._board = board;
    if (!el._wbClick) { el._wbClick = true; el.addEventListener('click', ev => { const t = ev.target.closest('.wk'); if (t) openCard(((el._board || {}).workers || []).find(w => w.id === t.dataset.id)); }); }
  }

  function summary(board) {
    const ws = (board && board.workers) || [], c = {};
    for (const w of ws) c[w.state] = (c[w.state] || 0) + 1;
    return '일꾼 ' + ws.filter(live).length + ' · 🔴' + (c.waiting_input || 0) + ' 🟡' + (c.working || 0) + ' 🟠' + (c.delegating || 0) + ' 🟢' + (c.reply_ready || 0);
  }

  function openCard(w) {
    if (!w) return;
    let dim = document.getElementById('wb-dim'), card = document.getElementById('wb-card');
    if (!dim) {
      dim = document.createElement('div'); dim.id = 'wb-dim'; dim.className = 'wb-dim'; document.body.appendChild(dim);
      card = document.createElement('div'); card.id = 'wb-card'; card.className = 'wb-card'; document.body.appendChild(card);
      dim.onclick = () => { dim.hidden = card.hidden = true; };
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape') dim.hidden = card.hidden = true; });
    }
    const s = st(w), f = fig(w, 40), inState = since(w.stateSince), born = since(w.createdAt), dt = w.detail || {};
    const load = w.load && typeof w.load.pct === 'number' ? w.load.pct + '% (' + ({ ok: '여유', warn: '⚠ 주의', hard: '⛔ 과다' }[w.load.zone] || w.load.zone || '') + ')' : '—';
    const where = [dt.branch, dt.dir].filter(Boolean).join(' @ ') || '—';
    card.innerHTML = '<button class="x" aria-label="닫기">✕</button><div class="hd"><span class="fig">' + f.html + '</span><div><b>' + esc(w.name || w.id) + '</b><small>' +
      s[0] + ' ' + s[1] + (inState == null ? '' : ' · ' + ago(inState) + (live(w) ? '째' : ' 전')) + (born == null ? '' : ' · 🐣 ' + ago(born) + ' 전 생성') + '</small></div></div>' +
      '<div class="now">' + (live(w) ? esc(w.now || '—') : '자리 비움 — 1시간 뒤 목록에서 사라진다') + '</div>' +
      '<dl><dt>마지막 지시</dt><dd>' + esc(w.ask || '—') + '</dd>' + (w.said ? '<dt>마지막 답</dt><dd>' + esc(w.said) + '</dd>' : '') +
      '<dt>브랜치</dt><dd>' + esc(where) + '</dd><dt>컨텍스트</dt><dd>' + esc(load) + '</dd>' +
      (w.link ? '<dt>링크</dt><dd><a href="' + esc(w.link) + '" target="_blank" rel="noopener">' + esc(w.link) + '</a></dd>' : '') + '</dl>';
    card.querySelector('.x').onclick = () => { dim.hidden = card.hidden = true; };
    dim.hidden = card.hidden = false;
  }

  async function fetchBoard() {
    const r = await fetch('/api/workers', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  window.WorkerBoard = { render, summary, openCard, fetchBoard, loadSprites, speciesOf, ST, ORDER };
}());
