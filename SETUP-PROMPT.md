# 셋업 프롬프트 — 자기 Claude Code 세션에 그대로 붙여 넣기

아래 블록 전체를 복사해서 맥의 Claude Code 세션에 붙여 넣으세요. 로그인처럼 사람이 해야 하는 단계는 세션이 멈추고 알려 줍니다.

````text
review-sheet(https://github.com/dd0114/review-sheet)를 이 맥에 설치하고, 폰에서도 Tailscale 로 열리게 해 줘.
review-sheet 는 나(사람)와 Claude Code 세션이 소통하는 로컬 받은편지함이야 — 세션은 결정할 게 2개 이상이면 "결정 시트"를 만들어 올리고,
나는 브라우저/폰에서 골라서 저장해. 그리고 "상시 채널(chat)" 로 세션과 메신저처럼 말을 주고받아.

순서대로 진행하고, 단계마다 결과를 한 줄씩 알려 줘.

1. 확인: `node -v` 가 18 이상인지. 아니면 설치 방법만 알려 주고 멈춰(내가 설치).
2. 설치:
   git clone https://github.com/dd0114/review-sheet ~/review-sheet
   mkdir -p ~/bin && ln -sf ~/review-sheet/bin/review-sheet.mjs ~/bin/review-sheet
   ~/bin 이 PATH 에 없으면 쉘 설정에 추가해도 되는지 먼저 물어봐.
   mkdir -p ~/.claude/skills && ln -sf ~/review-sheet ~/.claude/skills/review-sheet   (이미 같은 이름이 있으면 덮지 말고 물어봐)
   cd ~/review-sheet && node --test test/   → 전부 통과해야 함
3. 상주 서버: `review-sheet install-inbox` (launchd, 포트 5600, 부팅 시 자동).
   확인: curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5600/  → 200. 그리고 `open http://127.0.0.1:5600/`.
   macOS 가 node 의 들어오는 연결 허용을 물으면 나한테 "허용" 눌러 달라고 해.
4. 시험 시트: `review-sheet new test-hello` 로 만들고, 데이터 파일(~/.review-sheet/inbox/test-hello-data.js)에
   쉬운 질문 1개(선택지 2개 + 추천)를 넣어. 내가 브라우저에서 고르고 저장하면 `review-sheet read test-hello` 로 읽어서 보여 줘.
5. 상시 채널: `review-sheet chat new main --title "메인 세션" --owner main`.
   그다음 `review-sheet chat wait main --timeout 14400` 을 백그라운드로 걸어. 내가 http://127.0.0.1:5600/chat.html?c=main 에
   글을 쓰면 `review-sheet chat say main "<답>"` 으로 답하고, 바로 다시 wait 를 걸어. 이걸 항상 유지해(타임아웃 exit 3 이어도 다시 걸기).
6. Tailscale(폰 접속):
   - `/Applications/Tailscale.app` 이 없으면 설치 방법(App Store 또는 `brew install --cask tailscale`)을 알려 주고, 로그인은 내가 할게.
   - 폰에도 Tailscale 앱을 깔고 같은 계정으로 로그인하라고 안내해.
   - 맥의 tailnet 주소 확인: `/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4` (100.x.x.x)
     → 폰 브라우저에서 http://<그 주소>:5600/ 가 열리는지 내가 확인할게. 안 열리면 방화벽·서버 바인드(--lan)부터 점검해.
7. 규칙 기록: 아래 운영 규칙을 내 전역 CLAUDE.md(~/.claude/CLAUDE.md)에 넣어도 되는지 **먼저 물어보고**, OK 하면 추가해:
   - 결정이 2개 이상이면 review-sheet 시트로 묻는다(SKILL.md 형식: 쉬운 말, 선택지마다 예시, 추천+이유, 사진은 그 질문에 붙인다).
   - 시트를 올렸으면 "리뷰해 주세요" 메시지를 따로 보내지 않는다 — 받은편지함이 알림이다.
   - 시트·서버·탭을 새로 늘리지 않는다 — 받은편지함 하나(:5600), 탭 하나.
   - chat 채널엔 항상 wait 를 걸어 두고, 컴팩션·재시작 직후 첫 할 일은 `review-sheet chat read main` → 답 → wait 재장전.

지키기:
- 서버엔 인증이 없다. 인터넷으로 포트를 열거나(포트포워딩·터널) 공개 주소로 내보내지 마. 폰 접속은 Tailscale 로만.
- 시트·채팅에 비밀번호·토큰·개인정보를 쓰지 마.
- 이 맥의 다른 설정(쉘 설정, CLAUDE.md, 권한 설정)은 내가 OK 한 것만 바꿔.
- 마지막에 3줄로 보고: 설치/테스트 결과, 받은편지함·채널 주소(로컬 + tailnet), 남은 사람 할 일.
````
