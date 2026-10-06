---
name: review-sheet
description: |
  리뷰어(hero)에게 결정을 받는 로컬 답변 시트. 세션이 질문·선택지·추천을 데이터 파일로 쓰고,
  hero 는 브라우저(폰 포함)에서 탭해 고르고 메모한 뒤 저장 — 답은 JSON 파일로 떨어지고 세션이 읽어 SoT 에 기록한다.
  대화창에서 "A/B 중 뭐요?" 를 여러 번 주고받는 대신, 결정 묶음을 한 페이지로 보내고 한 번에 회수한다.
triggers:
  - /review-sheet
  - 답변 시트 만들어
  - 리뷰 시트
  - hero 결정 받아야 하는 질문 묶음
  - 시안 판정 받기
---

# /review-sheet — 결정은 페이지로 보내고 파일로 받는다

## 언제 쓰나

- hero 결정이 **2개 이상** 걸려 있을 때 (룰 선택, 시안 A/B/C 판정, 계획 승인의 세부 선택지, 배포 옵션).
- 사람이 **이슈를 안 열고도** 고를 수 있어야 할 때 — 폰에서 본다고 가정한다.
- 답을 **기록으로 남겨야** 할 때 — 저장된 JSON 이 곧 증빙이고, `read` 출력(마크다운)을 이슈/원장에 그대로 붙인다.

쓰지 않는 경우: 질문 1개(그냥 묻는다), 즉시 실행 가능한 trivial 결정(자율 결정 + Decision log), 사람 게이트가 아닌 기계 판정.

## 원칙 (실사용에서 굳은 것)

1. **리뷰 자료는 로컬 파일 + 로컬 서브** — claude.ai 아티팩트·외부 호스팅 금지. 레포 트리와 리뷰 페이지가 같은 것이어야 한다.
2. **hero 가 읽는 글은 전부 쉬운 말** — 스펙 절 번호, 이슈 내부 id, 코드명, 전문용어 금지. 질문마다 `sit`(지금 상황) · `decide`(정하는 것) · `effect`(고르면 달라지는 것) 를 채우고, 선택지마다 **예시 한 줄**.
3. **추천을 반드시 단다**(`rec` + `why`). "빈 칸 = 추천" 버튼이 있어서 hero 는 동의하는 건 건너뛰고 다른 것만 고른다.
4. **되묻기는 새 시트** — 답변 1 에서 애매한 것만 모아 `<name>b` 시트를 만든다. 답한 시트는 덮어쓰지 않는다(기록).
5. **답은 세션이 다시 치지 않는다** — `read` 출력을 SoT(이슈 코멘트 / 결정 원장)에 붙이고, 해석("~로 읽었다")을 한 줄 덧붙인다. 해석이 둘로 갈리면 되묻는다(원칙 4).
6. 서버는 **디렉토리당 1개**, 포트는 세션마다 고정해 두고 URL 을 보고에 쓴다. 폰에서 보게 하려면 `--lan`.
7. **검수는 시트로만** (hero 2026-10-03). hero 에게 보여줄 것(그림 · 영상 · 화면 · 시안)과 hero 가 고를 것은 전부 시트(받은편지함)로 보낸다.
   채팅 채널 · 브라우저 탭 · `open` 명령 · 링크 단독 전달로 검수를 보내지 않는다. 채팅은 hero 질문에 대한 답과 hero 가 요청한 진행 보고에만 쓴다.
   ⚠️ 채팅에서 **답하지 말라는 뜻이 아니다** — hero 가 채팅으로 묻거나 지시하면 항상 채팅으로 답한다. 금지는 hero 가 검수·결정해야 할 것(세션이 hero 답을 기다려야 하는 것)을 채팅으로 묻는 것뿐이다.
   hero 의 실제 브라우저(크롬 등) 조작은 그 일을 맡은 **한 세션만** 한다 — 나머지 세션은 브라우저 도구 · `open` 을 쓰지 않고, 스크린샷이 필요하면 headless 로 찍어 시트에 붙인다.

## 절차 — 받은편지함(inbox) 하나로

시트는 **한 폴더**(`~/.review-sheet/inbox`, `$REVIEW_SHEET_INBOX`)에 모이고, 그 폴더를 **상주 서버 하나**(`:5600`)가 큐처럼 보여 준다.
첫 화면은 "답 기다리는 중 N / 제출됨 N" 두 묶음 — 제출된 시트는 녹색 띠·✓ 제출됨 배지로 구분되고, 열어도 상단에 "✓ 제출됨 <시각>" 띠가 뜬다.
hero 는 탭 하나만 둔다(5초마다 자동 갱신). 세션마다 서버·포트·탭을 새로 띄우지 않는다.

```
0. 설치(기기당 1회)  node <SKILL_DIR>/bin/review-sheet.mjs install-inbox && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.review-sheet.inbox.plist
                     (macOS 외 / 수동: node <SKILL_DIR>/bin/review-sheet.mjs serve   ← dir 생략 = inbox, :5600)
1. 작성   REVIEW_SHEET_FROM=<세션 이름> node <SKILL_DIR>/bin/review-sheet.mjs new <도메인>-<이름>   → inbox/<…>-data.js 를 채운다 (아래 데이터 형식)
          이름은 inbox 전체에서 유일해야 하니 도메인 접두를 붙인다 (spider-prs, pkch-v1-rules). from/createdAt 은 자동.
2. 보고   "http://127.0.0.1:5600/sheet.html?d=<이름>" (받은편지함: http://127.0.0.1:5600/) 를 hero 에게.
          폰에서 볼 땐 127.0.0.1 이 폰 자신이라 안 열린다 — `new` 가 같이 찍어 주는 LAN/tailnet 주소(예: http://<tailscale-ip>:5600/)를 보낸다. 질문 수 · 소요 1분 안내. 🛑 여기서 멈춘다.
3. 대기   node <SKILL_DIR>/bin/review-sheet.mjs wait <이름> --timeout 3600   (제출되면 마크다운으로 출력, exit 0)
          또는 hero 가 "제출했어" 라고 하면  … read <이름>
4. 기록   read 출력 → SoT (이슈 코멘트 "hero 답변 N" / 결정 원장). 해석 한 줄. 되물을 것은 <이름>b 시트로 (원칙 4).
5. 진행   답에 따라 구현. 시트 파일은 inbox 에 남긴다 — "제출됨" 묶음이 곧 결정 기록이다.
```

레포 안에 시트를 **커밋으로 남기고 싶으면** 예전처럼 `<dir>` 를 명시해 쓴다(`new review/ <name>`, `serve review/ --port N`). 그때도 hero 에게는 inbox 로 복사해 보내는 쪽이 낫다(탭 하나 원칙).

`<SKILL_DIR>` = 이 SKILL.md 가 있는 디렉토리. CLI 를 자주 쓰면 `ln -s <SKILL_DIR>/bin/review-sheet.mjs ~/bin/review-sheet`.

## 상시 채널 (chat) — hero ↔ 세션 메신저

결정 묶음(시트)과 별개로, hero 가 특정 세션과 **그냥 말을 주고받는** 채널. 받은편지함 맨 위 "상시 채널" 에 뜨고, 페이지는 메신저(말풍선·Enter 전송·3초 갱신·링크 자동 연결·"읽음" 표시)다. 채널은 세션 하나가 소유한다(hero 가 root 와, pkch:main 과 각각).

```
세션(소유자) 쪽
  review-sheet chat new <ch> --title "<표시 이름>" --owner <세션>   # 1회. inbox/chat/<ch>.json + .jsonl
  review-sheet chat wait <ch> --timeout 14400                      # 백그라운드. hero 새 메시지가 오면 출력하고 exit 0 (읽음 처리) → 답하고 다시 wait
  review-sheet chat say  <ch> "<답>"      (또는  … say <ch> - <<< "$text")   # 소유자 이름으로 기록
  review-sheet chat read <ch> [--all] [--json]                     # 안 읽은 hero 메시지(또는 전부)
  review-sheet chat ls
hero 쪽
  http://127.0.0.1:5600/chat.html?c=<ch>   (폰: tailnet 주소) — 받은편지함에서 채널을 누르면 열린다
```

### 메인 허브 — 받은편지함을 열면 기본으로 연결되는 채널

채널 중 하나가 **메인 허브**다 = hero 의 메인 세션(오케스트레이터)이 소유한 채널. 받은편지함 맨 위에 ★ 로 고정되고, `http://<주소>:5600/hub` 가 그 채널로 바로 열린다(폰 즐겨찾기는 이 주소 하나). 도메인 매니저·워커 채널은 그 아래에 붙는다.

```
review-sheet chat new main --title "메인 허브" --owner main --hub   # 메인 세션이 1회. 첫 채널은 --hub 없이도 허브가 된다
review-sheet chat hub            # 지금 허브 보기
review-sheet chat hub <ch>       # 허브 바꾸기(하나만)
```

- 허브 채널은 **메인 세션만** 소유한다. 다른 세션은 자기 채널을 만들되 `--hub` 를 쓰지 않는다.
- hero 가 어디로 말할지 모르면 허브로 말한다 → 메인 세션이 해당 세션에 전달한다.

규칙
- 세션은 채널에 **항상 `wait` 를 걸어 둔다**(백그라운드 1개). 끝나면(hero 메시지 수신 / 타임아웃 exit 3) 답하고 즉시 다시 건다. 컴팩션·재기동 후에도 첫 할 일은 `chat read <ch>` → 답 → `wait` 재장전.
- 답은 짧게, 대화창 말투 그대로. 긴 결정은 시트로 보내고 채널엔 링크만.
- `wait` 는 소유 세션만 건다. 다른 세션 채널의 `say`/`read` 를 대신 하지 않는다(읽음 표시가 거짓이 된다).
- 채널 메시지는 SoT 가 아니다 — 거기서 난 결정은 이슈/원장에 옮겨 적는다.

## 메모 (memo) — hero 가 자기한테 보내는 메시지, 세션은 읽지 않는다

받은편지함 맨 위 "📝 나와의 메시지" (`http://127.0.0.1:5600/memo.html`, 폰은 tailnet 주소). 채널과 같은 모양이지만 **답장 없는 1대1 메시지**다 — 적고 보내면 말풍선으로 쌓이고(`inbox/memo/hero.jsonl`, 한 줄 = 한 메시지), 저장·초안·충돌 같은 개념이 없다. **말풍선을 누르면 본문이 복사**된다(hero 2026-10-06: 주로 복사용으로 쓴다). 메시지 하나는 시각 옆 "지우기" 로 지운다. 10-06 이전의 한 장짜리 메모(`hero.md`)는 처음 열 때 빈 줄 기준 단락마다 메시지 하나로 옮겨지고 원본은 `hero.md.migrated` 로 남는다.

**세션 규칙** (hero 2026-10-06): 이건 hero 가 **자기와 대화하는 칸**이다. 세션은 `inbox/memo/` 를 읽지도 쓰지도 않고, CLI 도 없다(`/api/inbox` 에도 건수·시각만 나가고 본문은 안 나간다). hero 가 메모 내용을 세션에 전하고 싶으면 채널(chat)이나 시트 메모칸에 옮겨 적는다 — 그때까지는 세션 입장에서 존재하지 않는 파일이다. `?m=<이름>` 으로 메모를 더 만들 수 있지만 그것도 전부 hero 것이다.

## 일꾼 보드 (workers) — 지금 누가 무슨 일을 하는지

받은편지함이 보여 줄 **일하는 세션 목록**. 리뷰시트는 tmux·claude·fleet 를 모른다 — 바깥 공급자가 아래 문서 하나를 주고, 서버는 그걸 그대로 `GET /api/workers` 로 낸다(CORS 없음 — 지시·답 문장이 들어 있다).

공급 순서: `$REVIEW_SHEET_WORKERS=<url>` 이면 서버가 그 URL 을 프록시(3초 타임아웃) → 실패하거나 없으면 `inbox/workers.json` 파일 → 둘 다 없으면 빈 보드. 응답에 어디서 왔는지 `source`(`url`·`file`·`none`)를 붙이고, URL/파일이 깨졌으면 이유를 `error` 에 적는다(그래도 200).

```json
{ "generatedAt": "ISO",
  "groups":  [{ "id": "sidekick", "name": "sidekick 방" }],
  "workers": [{ "id": "sidekick:tfs/slackmsg", "group": "sidekick", "name": "슬랙메시지조사",
                "state": "working|waiting_input|reply_ready|delegating|gone",
                "stateSince": "ISO", "createdAt": "ISO",
                "now": "'…' 하는 중", "ask": "마지막 지시 첫 줄", "said": "마지막 답 첫 줄",
                "load": { "pct": 25, "zone": "ok|warn|hard" },
                "detail": { "branch": "main", "dir": "~/…" }, "link": null }] }
```

| 키 | 뜻 |
|---|---|
| `groups[]` | 방(도메인). 보드는 방별로 묶고 방 안에서 상태순(`waiting_input` 먼저) |
| `id` · `group` · `name` | 고유 id · 소속 방 id · 일꾼 이름표 |
| `state` | 표준 상태 어휘 5개 — `working` 작업 중 · `waiting_input` 사람 입력 필요 · `reply_ready` 답 와있음(확인 대기) · `delegating` 부하(서브에이전트)에게 시키는 중 · `gone` 사라짐(공급자가 1시간쯤 남겼다 뺀다) |
| `stateSince` · `createdAt` | 두 시계 — 이 상태로 얼마나 · 태어난 지 얼마나 |
| `now` | 지금 하는 일 한 줄(공급자가 상태별로 조립, 120자 안팎) |
| `ask` · `said` | 마지막 지시 첫 줄 · 마지막 답 첫 줄 |
| `load` | 컨텍스트 피로도 `{pct, zone}` — `zone` 은 `ok·warn·hard`. 모르면 `null` |
| `detail` · `link` | 브랜치@폴더 등 탭하면 보이는 것 · 열어 볼 링크(없으면 `null`) |

`id` 가 없는 항목은 버린다. 그 밖의 키는 손대지 않고 넘긴다. 가짜 보드(상태 5종 전부): `test/fixtures/workers.json` — `cp test/fixtures/workers.json ~/.review-sheet/inbox/` 로 화면을 볼 수 있다.

## 데이터 형식 (`<name>-data.js`)

```js
window.SHEET = {
  id: 'v1-rules',                      // [a-z0-9-] — answers/<id>.json
  title: 'v1 게임 규칙 — 7건',
  eyebrow: 'myproj · 2026-10-01 · 이슈 #12', lede: '한 줄 요약(HTML 가능)',
  issueUrl: 'https://github.com/OWNER/REPO/issues/',   // section.issue 숫자가 여기 붙는다
  sections: [{
    id: 'r7a', code: 'R7a', issue: 273, first: true,   // code 가 답 키 접두("R7a-1"), first = "먼저" 배지
    title: '합성 숫자 누적',
    ask: 'hero 가 전에 한 말 그대로',  now: '지금 상태 한두 문장 (글자 — 줄바꿈 \\n, 강조 <b><i><code><br> 만)',
    links: [['화면 열기', 'http://127.0.0.1:5200/m4.html?state=x']],   // 선택 — 같은 페이지 안 팝업(iframe)으로 열린다
    images: [['shots/overview.png', '전체 흐름']],                        // 선택, 시트 dir 기준 상대경로 — 섹션 공통 그림 1장 정도만
    table: { head: ['안', '모양', '변수'], rows: [['A', '…', '1']], note: '숫자 전부 임시' },  // 선택
    questions: [
      { k: '1', q: '“+1” 은 무엇을 올리나',
        sit: '지금 상황', decide: '정하는 것', effect: '고르면 달라지는 것',
        images: [['shots/q1.png', '지금 화면']],   // ★ 질문이 보는 사진은 그 질문에 붙인다(바로 아래 렌더). links 도 같은 식
        opts: [['① 표시만', '예: 9 (+1)'], ['② 스택 +1', '예: ♠ +1'], ['③ 메모로 다시']],
        rec: '①', why: '추천 이유 한 줄' },
      ['2', '옛 튜플 형식도 된다', ['① 예', '② 아니오'], '②', '이유'],
    ],
  }],
};
```

`from`(보낸 세션) · `createdAt` 은 `new` 가 채운다 — inbox 큐의 출처·정렬에 쓴다.

**글 칸은 HTML 이 아니다** (hero 2026-10-05): `ask`·`now`·`sit`·`decide`·`effect`·`why`·질문·선택지·표 는 글자 그대로 보인다. 줄을 나누려면 `\n`, 강조는 `<b>` `<i>` `<code>` `<br>` 까지만 통하고 그 밖의 태그는 글자로 뜬다. HTML 전체가 되는 칸은 `lede`·`howto`·섹션 `html` 셋뿐. `read` 는 그 표시들을 마크다운(`**` `_` `` ` ``)으로 바꿔 SoT 에 낸다. "문제 / 한 것 / 남은 것" 처럼 단락이 나뉘면 `now` 에 몰지 말고 `sit`·`decide`·`effect` 세 칸에 나눠 쓴다.

`links` · `images` · 선택지 썸네일은 전부 **같은 페이지 안 팝업**으로 열린다(hero: 창 여러 군데 왔다갔다 금지). 같은 버튼 다시 탭 = 닫기, Esc = 닫기. 팝업 바의 "새 탭" 은 iframe 을 거부하는 사이트(GitHub 등) 용 — 그런 링크는 가급적 넣지 말고 내용을 시트에 옮긴다. 목업·로컬 서브 페이지(127.0.0.1)는 그대로 뜬다.

**사진은 질문마다 붙인다** (hero 2026-10-02): 질문 N개가 각자 다른 화면을 보는 시트라면 섹션 `images` 에 N장을 몰아 두지 말고, 각 질문 객체의 `images`(·`links`)에 그 질문이 보는 사진만 넣는다. 그러면 사진이 질문 글 바로 아래, 선택지 바로 위에 뜬다 — hero 가 위의 사진 더미와 아래 질문 사이를 오가지 않고 질문 하나에 집중한다. 섹션 `images` 는 모든 질문이 공통으로 보는 그림 1장 정도에만 쓴다.

선택지 라벨은 `①②③` 처럼 **토큰으로 시작**해야 `rec: '①'` 이 추천 하이라이트와 "빈 칸 = 추천" 에 걸린다. 선택지 셋째 칸은 썸네일 이미지 경로(선택).

## 답 형식 (`answers/<id>.json`)

```json
{ "sheet": "v1-rules", "issues": [273], "savedAt": "2026-10-01T00:23:11.000Z",
  "answers": { "R7a-1": { "pick": "① 표시만" }, "R7a-2": { "memo": "둘 다 아니고 …" }, "R7a-memo": { "memo": "전체 메모" } } }
```

`read` 는 이것을 질문과 합쳐 마크다운 표로 낸다 — 그대로 SoT 에 붙인다. `--json` 이면 원본.

## CLI

`[dir]` 를 생략하면 inbox(`~/.review-sheet/inbox`). 명시하면 그 폴더(레포 안 `review/` 등).

| 명령 | 뜻 |
|---|---|
| `serve [dir] [--port N] [--lan]` | 폴더와 시트 페이지를 서브. `/` 는 큐(답 기다림 ↑ / 제출됨 ↓, 5초 자동 갱신), `/api/sheets` 는 같은 목록 JSON(CORS 열림 — 다른 대시보드 배지용). inbox 면 기본 :5600 |
| `install-inbox [--port N]` | launchd 플리스트(`com.review-sheet.inbox`) 작성 — inbox 를 부팅 시 `--lan` 으로 서브. 출력된 `launchctl bootstrap` 을 실행 |
| `new [dir] <name>` | 템플릿 복사 → `<name>-data.js` (`from` = `$REVIEW_SHEET_FROM` / fleet sender / user@host, `createdAt` 자동) |
| `ls [dir]` | 시트 목록 + 대기/제출됨 + 진행(답한 수/전체) + 제출 시각 |
| `read [dir] <name|id> [--json]` | 제출된 답을 질문과 합쳐 마크다운(없으면 exit 4) |
| `wait [dir] <name|id> [--timeout SEC]` | 제출될 때까지 블록(기본 1h, 타임아웃 exit 3) → 제출되면 `read` 와 같은 출력 |
| `chat new <ch> [--title T] [--owner S]` | 상시 채널 생성(inbox 고정) |
| `chat hub [<ch>]` | 메인 허브 채널 보기/지정 — 받은편지함 맨 위 ★, `/hub` 리다이렉트 |
| `chat wait <ch> [--timeout SEC]` | hero 의 새 메시지까지 블록(exit 3 = 타임아웃) → 출력 + 읽음 처리. 첨부 이미지는 `[이미지] <절대경로>` 줄로 나온다 → Read 로 열어 본다 |
| `chat say <ch> <text…\|->` | 소유자 이름으로 답 기록 (`-` = stdin) |
| `chat read <ch> [--all] [--json]` · `chat ls` | 안 읽은 메시지 / 전부 · 채널 목록(미읽 수) |

HTTP: `/hub`(허브 채널로 302), `/api/inbox`(시트+채널+메모 건수), `/api/chats`, `/api/chat?c=`, `POST /__chat?c=` `{text}`(페이지 = hero), 전부 CORS 열림. 메모: `GET /api/memo?m=` · `POST /__memo?m=` `{text}` 보냄 / `{del: id}` 지움 (CORS 없음 — 페이지만 쓴다, 세션 금지). 일꾼 보드: `GET /api/workers` (CORS 없음, §일꾼 보드).

의존성 없음, Node 18+. 테스트: `node --test <SKILL_DIR>/test/`.

## Do NOT

- 시트를 claude.ai 아티팩트나 외부 URL 로 내지 마라 (원칙 1).
- `inbox/memo/` (나와의 메시지) 를 읽거나 쓰지 마라 — hero 전용이다. 거기 적힌 말은 hero 가 채널·시트로 옮겨 줄 때까지 세션에 온 적 없는 말이다 (hero 2026-10-06).
- hero 글에 내부 id·절 번호를 쓰지 마라 (원칙 2). "R9b 참조" 대신 그 내용을 한 줄로.
- 글 칸(`now` 등)에 HTML 로 서식을 짜지 마라 — `\n` 과 `<b>`·`<br>` 정도만 통한다. 단락이 셋이면 `sit`·`decide`·`effect` 로 나눈다 (hero 2026-10-05).
- 답한 시트를 고쳐 다시 묻지 마라 — 새 시트 (원칙 4).
- `wait` 를 걸어 두고 hero 에게 "저장하면 알려줘" 를 또 요구하지 마라 — 둘 중 하나.
- 추천 없는 질문을 내지 마라. 추천을 못 고르겠으면 그 이유가 곧 `why` 다.
- 시트마다 서버·포트·탭을 새로 띄우지 마라 — inbox 하나, 탭 하나 (hero 2026-10-02).
- 시트를 올렸으면 **리뷰 요청 메시지를 따로 보내지 마라** — 받은편지함의 "답 기다리는 중" 과 queue 배지가 알림이다. 채널(chat)·터미널·fleet send 로 "리뷰해 주세요" 를 중복 보내지 않는다 (hero 2026-10-02). 채널엔 hero 가 먼저 물었을 때만 링크로 답한다.
- 제출된 시트를 "대기" 처럼 보이게 하지 마라 — 제출 표시(배지·띠)는 서버/페이지가 자동으로 붙인다. 지우거나 흉내내지 않는다.
- hero 에게 보여줄 것을 브라우저 탭·`open`·채팅 링크로 띄우지 마라 — 시트에 `images`/`links` 로 넣는다 (원칙 7). hero 화면에 창이 저절로 뜨는 것 자체가 방해다.
- 사진 N장을 섹션 위에 몰아 두고 질문 N개를 따로 늘어놓지 마라 — 질문마다 `images` 로 그 질문의 사진을 붙인다(hero 2026-10-02).
- hero 가 다른 창으로 가야 답할 수 있는 시트를 만들지 마라 — 봐야 할 것은 `links`/`images` 로 시트 안에서 열리게 하거나 본문에 옮긴다.
