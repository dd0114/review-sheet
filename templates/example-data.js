/* review-sheet data file — one sheet. Open with  sheet.html?d=<this file name without -data.js>
   Answers save to <dir>/answers/<id>.json. Everything the reviewer reads must be plain language:
   no spec section codes, no issue-internal ids, no jargon. One example per option. */
window.SHEET = {
  id: 'example',    // [a-z0-9-] — the answers file name
  from: '',          // who sent it (filled by `new`: $REVIEW_SHEET_FROM / fleet sender / user@host)
  createdAt: '',     // ISO time (filled by `new`); the inbox sorts pending sheets by this
  title: '예시 시트 — 무엇을 정할지',
  eyebrow: '프로젝트 · 2026-01-01 · 리뷰 1',          // optional
  lede: '한 줄 요약. <b>HTML 허용</b>.',             // optional, html
  issueUrl: 'https://github.com/OWNER/REPO/issues/', // optional — section.issue (a number) links here
  sections: [
    {
      id: 'a', code: 'A', issue: 1, first: true,      // code = answer key prefix ("A-1"); first = "먼저" badge
      title: '첫 번째 항목 — 결정 두 개',
      ask: '리뷰어가 전에 한 말을 그대로',              // optional, quoted at the top
      now: '지금 상태를 한두 문장으로',                 // optional
      links: [['관련 화면 열기', 'http://127.0.0.1:5200/page.html']],   // optional
      // images: [['shots/overview.png', '전체 흐름']],   // optional, paths relative to the sheet dir — section-wide picture only
      table: { head: ['안', '모양', '변수'], rows: [['A', '한 줄', '1'], ['B', '다른 줄', '3']], note: '숫자는 전부 임시' }, // optional
      questions: [
        { k: '1', q: '질문 한 줄',
          sit: '지금 어떤 상황인지', decide: '무엇을 정하는지', effect: '고르면 뭐가 달라지는지',
          // images: [['shots/q1.png', '이 질문이 보는 화면']],   // optional — attach the picture TO the question (renders right under it)
          opts: [['① 선택지 하나', '예시 한 줄'], ['② 선택지 둘', '예시 한 줄'], ['③ 메모로 다시']],
          rec: '①', why: '추천 이유 한 줄' },
        { k: '2', q: '두 번째 질문', opts: [['① 예'], ['② 아니오']], rec: '②' },   // option[2] = thumbnail path (optional)
      ],
    },
  ],
};
