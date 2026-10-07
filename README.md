# review-sheet

사람 ↔ Claude Code 세션 소통용 **로컬 받은편지함**. 의존성 없음, Node 18+, CLI 하나.

- **결정 시트** — 세션이 질문·선택지·추천을 데이터 파일로 쓰면, 사람은 브라우저(폰 OK)에서 탭으로 고르고 메모한 뒤 저장. 답은 `answers/<id>.json` 으로 떨어지고 세션이 마크다운으로 읽어 간다. 대화창에서 "A/B 중 뭐요?" 를 여러 번 주고받는 대신 한 페이지로 보내고 한 번에 받는다.
- **상시 채널(chat)** — 사람과 특정 세션 사이의 메신저 페이지(말풍선·Enter 전송·읽음 표시·이미지 첨부 📎/붙여넣기/끌어놓기). 세션은 `chat wait` 를 백그라운드로 걸어 두고, 메시지가 오면 답하고 다시 건다.
- **메인 허브** — 채널 하나를 메인 세션의 허브로 지정(`--hub`, 첫 채널은 자동). 받은편지함 맨 위에 ★ 고정, `/hub` 가 바로 그 채널. 프로젝트 매니저·워커 채널은 그 아래.
- **🎤 음성 입력** — 채팅 입력칸·시트 메모칸·메모 옆 마이크(탭 = 녹음, 다시 탭 = 전사). 전사는 **이 맥에서만**(ffmpeg → whisper.cpp `large-v3-turbo`, 한국어, `~/.review-sheet/vocab.txt` 단어장). 폰 마이크는 HTTPS 가 필요해 `bin/tailscale-serve.sh on` 으로 tailnet 안에서만 감싼다.
- **메모(memo)** — hero 가 자기한테 보내는 답장 없는 1대1 메시지(`/memo.html`). 채널 모양으로 쌓이고, **말풍선을 누르면 복사**된다. 저장·초안 개념 없음, `inbox/memo/hero.jsonl` 한 줄 = 한 메시지. **세션은 읽지도 쓰지도 않는다** — hero 가 자기와 대화하는 칸이다.
- **받은편지함 하나, 서버 하나, 탭 하나** — 모든 세션이 `~/.review-sheet/inbox` 에 시트를 넣고, 상주 서버(`:5600`)가 큐처럼 보여 준다(답 기다리는 중 / 제출됨).
- **폰에서** — [Tailscale](https://tailscale.com) 로 맥과 폰을 같은 tailnet 에 두면 밖에서도 `http://<맥 tailnet 주소>:5600/` 로 열린다.

이 문서에서 **hero** = 결정을 내리는 사람(리뷰어). 채팅 기록의 `from: 'hero'` 도 같은 뜻이다.

## 설치 (macOS)

```bash
git clone https://github.com/dd0114/review-sheet ~/review-sheet
mkdir -p ~/bin && ln -sf ~/review-sheet/bin/review-sheet.mjs ~/bin/review-sheet   # PATH 에 ~/bin
mkdir -p ~/.claude/skills && ln -sf ~/review-sheet ~/.claude/skills/review-sheet   # Claude Code 스킬로 등록
review-sheet install-inbox            # launchd plist 생성(:5600, 기본 --lan) → 출력된 launchctl bootstrap 명령 실행(부팅 시 자동)
open http://127.0.0.1:5600/
```

Linux 는 `install-inbox` 대신 `review-sheet serve --port 5600 --lan` 을 systemd user 서비스 등으로 띄운다.

## 쓰기

```bash
REVIEW_SHEET_FROM=myproj review-sheet new myproj-v1-rules    # 템플릿 → inbox/myproj-v1-rules-data.js (편집)
                                                              # → http://127.0.0.1:5600/sheet.html?d=myproj-v1-rules
review-sheet wait myproj-v1-rules     # 제출될 때까지 블록, 마크다운 출력
review-sheet read myproj-v1-rules [--json]
review-sheet ls                       # 대기 / 제출됨

review-sheet chat new main --title "메인 허브" --owner main --hub   # → http://127.0.0.1:5600/hub
review-sheet chat wait main --timeout 14400   # 세션: 사람이 쓸 때까지 블록 → chat say main "…" 로 답 → 다시 wait
review-sheet chat say main "답장"
node --test test/
```

시트 데이터 형식·작성 원칙(쉬운 말, 추천 필수, 질문마다 사진)은 [`SKILL.md`](SKILL.md). 무엇을·언제·어떻게 물을지(공통 판단 규칙)도 거기에, 작업 영역별 노하우는 [`domains/visual.md`](domains/visual.md)(화면·연출) · [`domains/backend-ops.md`](domains/backend-ops.md)(백엔드·운영).

## 보안 — 꼭 읽기

서버에 **인증이 없다.** `--lan` 이면 같은 네트워크의 누구나 시트를 읽고 채팅에 글을 쓸 수 있다(CORS 도 열려 있음).

- 집·회사처럼 믿을 수 있는 네트워크 + Tailscale 에서만 `--lan` 을 쓴다. 카페·공용 와이파이에선 `--lan` 을 끄거나 방화벽으로 막는다.
- 폰 접속은 Tailscale 주소로만 하는 것을 권한다(tailnet 은 내 기기끼리만 보인다). 인터넷에 포트를 열지 않는다.
- 시트에 비밀번호·토큰·개인정보를 넣지 않는다.

## 처음 쓰는 사람에게

[`SETUP-PROMPT.md`](SETUP-PROMPT.md) 의 프롬프트를 자기 Claude Code 세션에 붙여 넣으면 설치 → 메인 허브 채널 → 폰 접속 확인까지 진행하고, 여러 Claude 세션을 나눠 쓰는 구조(허브 → 프로젝트 매니저 → 워커)는 참고 예시로만 보여 주고, 지금 쓰는 방식에 맞춰 가볍게 제안한다.

## License

MIT
