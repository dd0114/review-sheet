# review-sheet

사람 ↔ Claude Code 세션 소통용 **로컬 받은편지함**. 의존성 없음, Node 18+, CLI 하나.

- **결정 시트** — 세션이 질문·선택지·추천을 데이터 파일로 쓰면, 사람은 브라우저(폰 OK)에서 탭으로 고르고 메모한 뒤 저장. 답은 `answers/<id>.json` 으로 떨어지고 세션이 마크다운으로 읽어 간다. 대화창에서 "A/B 중 뭐요?" 를 여러 번 주고받는 대신 한 페이지로 보내고 한 번에 받는다.
- **상시 채널(chat)** — 사람과 특정 세션 사이의 메신저 페이지(말풍선·Enter 전송·읽음 표시·이미지 첨부 📎/붙여넣기/끌어놓기·카톡식 답장 ↩ — 원문 인용, 누르면 이동). 세션은 `chat wait` 를 백그라운드로 걸어 두고, 메시지가 오면 답하고 다시 건다.
- **메시지 종류 칩** — 채팅 ＋ 줄의 '🏷 고급'(기기에 기억, 기본 꺼짐)을 켜면 입력칸 위에 `이슈 제기`·`버그 제보`·`지난 이슈 확인` 칩. 고른 메시지는 말풍선에 배지가 붙고, 세션의 `chat wait/read` 에는 `[이슈제기]` 등 태그와 할 일 한 줄이 붙는다 — 이슈 제기 = 먼저 SoT 이슈 만들고 답장에 링크, 버그 제보 = bug 이슈 만들고 바로 고침, 지난 이슈 확인 = 관련 이슈 현재 상태부터 답. 안 고르면 평문.
- **메인 허브** — 채널 하나를 메인 세션의 허브로 지정(`--hub`, 첫 채널은 자동). 받은편지함 맨 위에 ★ 고정, `/hub` 가 바로 그 채널. 프로젝트 매니저·워커 채널은 그 아래.
- **🎤 음성 입력** — 채팅 입력칸·시트 메모칸·메모 옆 마이크(탭 = 녹음, 다시 탭 = 전사). 전사는 **이 맥에서만**(ffmpeg → whisper.cpp `large-v3-turbo`, 한국어, `~/.review-sheet/vocab.txt` 단어장). 폰 마이크는 HTTPS 가 필요해 `bin/tailscale-serve.sh on` 으로 tailnet 안에서만 감싼다.
- **메모(memo)** — hero 가 자기한테 보내는 답장 없는 1대1 메시지(`/memo.html`). 채널 모양으로 쌓이고, **말풍선을 누르면 복사**된다. 저장·초안 개념 없음, `inbox/memo/hero.jsonl` 한 줄 = 한 메시지. **세션은 읽지도 쓰지도 않는다** — hero 가 자기와 대화하는 칸이다.
- **＋ 이것만 묻기** — 문항·항목 메모 밑 버튼. 그 문항 하나만 묻는다(시트는 제출 안 됨). 질문과 답은 시트 안에만 산다(`<inbox>/asks/<시트>.jsonl`, 채널에 안 감). 시트를 쓴 세션 창으로 바로 가고(`REVIEW_SHEET_ASK_HOOK` — 아래), 세션이 `review-sheet ask-reply <시트> <문항> "…"` 로 답하면 시트 그 문항 밑에 바로 뜬다. 10분 무응답이면 담당 채널(없으면 허브)에 한 줄 한 번.
- **문항 질문** — 문항마다 '＋ 이것만 묻기'. 그 문항 하나만 담당 세션에 묻고, 답은 그 문항 밑에 뜬다. (시트 맨 아래 '추가 질문' 칸은 2026-10-19 에 뺐다.)
- **✓ 보고 시트** — 머지·배포 같은 알림 시트(`report: 'merged'` 등)는 제출 대신 ✓ 확인 체크(목록 줄 왼쪽 또는 시트 아래 줄). 체크는 세션을 깨우지 않고, 세션이 나중에 `checks` 로 한 번에 본다.
- **끝난 상태 태그** — 답을 받은 세션이 후속 일을 `assign`(이슈·담당)하고 단계마다 `stage` 한 줄을 남기면, '제출됨' 목록의 그 시트 줄 맨 앞에 끝난 상태가 붙는다(예: `🚀 배포됨 · 스위치 꺼짐 · 다음 시즌 공개`). 상태가 바뀐 시트는 위로 올라온다.
- **진행판(`/board`)** — 바깥 스크립트가 넘긴 카드 목록을 할 일 · 하는 중 · 기다림 · 배포 대기 · 끝 다섯 칸으로 보여 주는 보기 전용 판(우선도·담당·'직접 작업 / 시스템 대기 / 쉬는 중'). 5초 갱신. GitHub 이슈를 읽어 칸을 채우는 생산자 `bin/board-feed.py` 동봉.
- **자원판(`/dash`)** — 바깥 스크립트가 넘긴 숫자 카드(메모리·디스크·사용량 …)와 줄 목록(무엇이 얼마나 쓰나)을 보여 주는 보기 전용 판. 카드나 줄을 누르면 그 항목의 시계열 그래프(선=자원, 막대=누적량). 생산자가 주간 토큰 총량을 주면 제목 옆 ⓘ 로 토큰을 주간 % 로 바꿔 본다. 30초 갱신.
- **받은편지함 하나, 서버 하나, 탭 하나** — 모든 세션이 `~/.review-sheet/inbox` 에 시트를 넣고, 상주 서버(`:5600`)가 큐처럼 보여 준다(답 기다리는 중 / 제출됨).
- **시트 관문(선택)** — `<inbox>/gate.json` = `{"cmd": ["/abs/prog", "arg"], "prefix": ["root-"]}` 를 두면, 이름이 접두사로 시작하는 시트마다 `cmd + [data.js 절대경로]` 를 셸 없이 10초 제한으로 돌린다(결과는 파일 mtime+size 로 캐시). exit 0 = 통과, 아니면 stderr(없으면 stdout) 첫 줄 300자가 이유 — 시트 맨 위 붉은 배너 `관문 통과 못 함 — <이유>`, 받은편지함 목록의 `관문` 표시, `review-sheet ls` 의 `관문✗`. 실행 자체가 안 되면(없는 프로그램·시간 초과) `관문 검사 실패: …` 경고만 띄우고 표시는 막지 않는다. `review-sheet gate [dir] [<id>]` 는 한 시트/전부에 돌려 줄로 찍고 실패가 있으면 exit 5. 파일이 없으면 기능 꺼짐.
- **탭 이름표** — 맥 여러 대의 받은편지함을 한 브라우저에서 같이 열 때 `review-sheet tab --prefix 구맥 --icon 🖥` 하면 그 서버의 모든 탭이 `구맥 · …` 제목 + 🖥 아이콘이 된다(`<inbox>/tab.json`, 재시작 없이 반영, env `REVIEW_SHEET_TAB_PREFIX`/`REVIEW_SHEET_TAB_ICON` 이 우선).
- **폰에서** — 서버는 기본 127.0.0.1 이라 폰에서 바로 안 열린다. [Tailscale](https://tailscale.com) 로 맥과 폰을 같은 tailnet 에 두고 `bin/tailscale-serve.sh on` 하면 `https://<맥>.<tailnet>.ts.net/` 로 열린다(마이크도 https 에서만). `--lan` 으로 띄우면 `http://<맥 tailnet 주소>:5600/` 도 된다.

이 문서에서 **hero** = 결정을 내리는 사람(리뷰어). 채팅 기록의 `from: 'hero'` 도 같은 뜻이다.

## 설치 (macOS)

```bash
git clone https://github.com/dd0114/review-sheet ~/review-sheet
mkdir -p ~/bin && ln -sf ~/review-sheet/bin/review-sheet.mjs ~/bin/review-sheet   # PATH 에 ~/bin
mkdir -p ~/.claude/skills && ln -sf ~/review-sheet ~/.claude/skills/review-sheet   # Claude Code 스킬로 등록
review-sheet install-inbox            # launchd plist 생성(:5600, 기본 127.0.0.1 — --lan 을 줄 때만 0.0.0.0) → 출력된 launchctl bootstrap 명령 실행(부팅 시 자동)
open http://127.0.0.1:5600/
```

Linux 는 `install-inbox` 대신 `review-sheet serve --port 5600` 을 systemd user 서비스 등으로 띄운다(기본 127.0.0.1). 폰은 `bin/tailscale-serve.sh on`(tailnet HTTPS)으로 감싸는 것을 권한다 — `--lan`(0.0.0.0)은 아래 보안 절을 읽고 필요할 때만.

## 쓰기

```bash
REVIEW_SHEET_FROM=myproj review-sheet new myproj-v1-rules    # 템플릿 → inbox/myproj-v1-rules-data.js (편집)
                                                              # → http://127.0.0.1:5600/sheet.html?d=myproj-v1-rules
review-sheet wait myproj-v1-rules     # 제출될 때까지 블록, 마크다운 출력
review-sheet read myproj-v1-rules [--json]
review-sheet ls                       # 대기 / 제출됨
review-sheet assign myproj-v1-rules '#12' myproj:main     # 후속 일 배정 → 시트가 닫힘
review-sheet stage myproj-v1-rules 라이브 --off --eta "다음 시즌" "16:05 배포"   # 끝난 상태 → 시트 줄 맨 앞 태그
review-sheet unassigned               # 배정 없음 · 문항 안 붙음 · 답 바뀜 · 되돌림 · 이슈 닫힘 시트 (시간 기준 '멈춤'은 없음)

review-sheet chat new main --title "메인 허브" --owner main --hub   # → http://127.0.0.1:5600/hub
review-sheet chat wait main --timeout 14400   # 세션: 사람이 쓸 때까지 블록 → chat say main "…" 로 답 → 다시 wait
review-sheet chat say main "답장"
review-sheet chat say main --re <id> "그 메시지에 대한 답"   # 카톡식 답장 — wait/read 출력 맨 앞 #id. hero 메시지에 답할 땐 항상
# 링크·"말씀 주세요" 같은 확인 요청·500자 넘는 글은 막힘(exit 6) — 결과물은 시트로. '보고:' 로 시작하는 글은 링크 통과(끝·머지·배포 보고의 확인 URL). 그 밖에 꼭 채팅인 알림만 --notice
# hero 메시지에 다는 답장(--re)은 2000자까지 — 물은 건 줄이지 말고 다 답한다(hero 2026-10-15)
node --test test/
```

## 다른 프로젝트에 붙이기 — hero 쪽 인터페이스 세 가지

어느 프로젝트든 세션은 CLI 만 쓰고, hero 는 받은편지함 탭 하나만 본다.

1. **대답하기** — 세션: `new` → 시트 작성 → `wait`/`read`. hero: 고르고 메모·첨부, 모자라면 문항의 '＋ 이것만 묻기'. 세션은 그 질문을 자기 창에서 받아 `ask-reply <시트> <문항> "…"` 로 답한다.

   **문항 질문 전달 훅** — `REVIEW_SHEET_ASK_HOOK=<명령 경로>` 를 서버 환경에 두면 질문마다 `<훅> <시트> <from> <문항> <질문 id>` 를 떼어 실행한다(질문 글은 stdin 과 `REVIEW_SHEET_ASK_TEXT`, 그 밖에 `REVIEW_SHEET_ASK_LABEL`·`REVIEW_SHEET_INBOX`·`REVIEW_SHEET_ASK_FILE`). 시트를 쓴 창을 찾아 넣는 일(창이 닫혔으면 그 대화를 다시 여는 일)은 설치 쪽 훅이 맡는다. 훅이 없거나 0 아닌 값으로 끝나면(또는 `REVIEW_SHEET_ASK_HOOK_MS`, 기본 5분 초과) 담당 채널(없으면 허브)로 한 통 — 그 메시지의 `chat say --re` 답장도 시트에 뜬다. 무응답 알림 시간은 `REVIEW_SHEET_ASK_STALE_MS`(기본 10분).
   **답 저장 훅** — `REVIEW_SHEET_ANSWER_HOOK=<명령 경로>` 를 서버 환경에 두면 답이 저장될 때마다 `<훅> <시트> <from> <답 파일 절대경로>` 를 떼어 실행한다(그 밖에 `REVIEW_SHEET_INBOX`·`REVIEW_SHEET_ANSWER_SUMMARY` = `3/4 선택 · 메모 2` 같은 한 줄). 세션이 `wait` 를 끝낸 뒤에 온 답도 그 창에 알리는 일은 설치 쪽 훅이 맡는다. 같은 시트를 5초 안에 다시 저장하면 한 번으로 묶어 창 끝에 부른다(그때 답 파일 = 마지막 답). 훅이 실패하거나 `REVIEW_SHEET_ANSWER_HOOK_MS`(기본 60초)를 넘기면 로그 한 줄뿐 — 저장·응답은 그대로. 훅이 없으면 아무 일 없다.
2. **끝난 상태 알리기** — 세션: 답을 받으면 `assign <시트> <이슈#> <담당>`, 일이 진행될 때마다 `stage <시트> 머지|배포대기|라이브|끝 [--off] [--eta <언제>] "<한 줄>"`. 태그는 `머지`=🔀 머지됨, `배포대기`=⏳ 배포 대기, `라이브`=🚀 배포됨, `--off`=스위치 꺼짐(어드민 스위치, 켜야 보임), `--eta <언제>`=배포·공개 예정(시각이나 '다음 시즌'). hero 는 시트 줄 맨 앞 태그만 보면 된다. `unassigned` 는 담당이 안 정해졌거나(배정없음) · 답한 문항이 장부에 안 붙었거나(문항안붙음) · 배정 뒤 답이 바뀌었거나(답바뀜) · 근거 PR 이 되돌려졌거나(되돌림) · 이슈는 닫혔는데 라이브·끝 전인(이슈닫힘) 시트를 찾는다(exit 5). 시간으로 '멈춤'을 재지 않는다(예전 24시간 기준은 뺐다).
3. **진행판 보기** — 프로젝트마다 생산자 스크립트를 하나 둔다(이슈 목록·작업 창·CI 상태를 읽어 60초마다). GitHub 이슈만으로 충분하면 동봉한 `bin/board-feed.py --config board-feed.json`(Python 3 + gh, 기본 180초마다, 자동 닫기는 켤 때만 — [`SKILL.md`](SKILL.md) §진행판 생산자):

   ```bash
   my-board-feed | review-sheet board -      # 검증 후 board.json 원자 교체 → http://127.0.0.1:5600/board
   ```

   ```json
   {"title": "진행판", "source": "my-board-feed", "cards": [
     {"id": "proj#12", "title": "로그인 오류", "status": "doing", "priority": "P1", "group": "proj",
      "owner": ["proj:main"], "mode": "system", "modeNote": "CI", "url": "https://…/issues/12", "at": "2026-10-14T01:00:00Z"}
   ]}
   ```

   `status` = todo · doing · wait(기다림) · ship(머지됨·배포 대기) · done, `mode` = claude(세션이 직접 작업) · system(테스트·CI 등을 기다림) · idle, `priority` = P0~P3(또는 긴급·높음·중간·낮음). 제목 없는 카드와 http(s) 아닌 url 은 버린다. 판은 보기만 한다 — 일은 이슈에서 바뀐다. 갱신이 10분 넘게 없으면 판에 경고가 뜬다.

시트 데이터 형식·작성 원칙(쉬운 말, 추천 필수, 질문마다 사진)은 [`SKILL.md`](SKILL.md). 무엇을·언제·어떻게 물을지(공통 판단 규칙)도 거기에, 작업 영역별 노하우는 [`domains/visual.md`](domains/visual.md)(화면·연출) · [`domains/backend-ops.md`](domains/backend-ops.md)(백엔드·운영).

## 보안 — 꼭 읽기

서버에 **인증이 없다.** 기본은 127.0.0.1(이 기기만)이고, `--lan` 이면 같은 네트워크의 누구나 시트를 읽고 채팅에 글을 쓸 수 있다(CORS 도 열려 있음).

- 집·회사처럼 믿을 수 있는 네트워크 + Tailscale 에서만 `--lan` 을 쓴다. 카페·공용 와이파이에선 `--lan` 을 끄거나 방화벽으로 막는다.
- 폰 접속은 Tailscale 주소로만 하는 것을 권한다(tailnet 은 내 기기끼리만 보인다). 인터넷에 포트를 열지 않는다.
- 시트에 비밀번호·토큰·개인정보를 넣지 않는다.

## 처음 쓰는 사람에게

[`SETUP-PROMPT.md`](SETUP-PROMPT.md) 의 프롬프트를 자기 Claude Code 세션에 붙여 넣으면 설치 → 메인 허브 채널 → 폰 접속 확인까지 진행하고, 여러 Claude 세션을 나눠 쓰는 구조(허브 → 프로젝트 매니저 → 워커)는 참고 예시로만 보여 주고, 지금 쓰는 방식에 맞춰 가볍게 제안한다.

## License

MIT

## 폰 알림 (hero 2026-10-16)

받은편지함을 **https 주소**로 열어 사파리 `공유 → 홈 화면에 추가` 한 뒤, 그 앱에서 받은편지함(또는 채널) 위의 `🔔 알림 켜기` 를 누른다(iOS 16.4+).
알림이 가는 것: 새로 온 시트만(보고 시트는 제목 앞에 🔀 머지됨 같은 배지). 안 가는 것: 채널 글(세션·hero 모두), 이미 제출된 시트.
의존성 없이 `bin/push.mjs`(VAPID + aes128gcm, node:crypto)로 보낸다. 키·구독은 `inbox/push/`(0600). `🔔 알림 켜짐 · 시험` 을 누르면 시험 알림.
