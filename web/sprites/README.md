# 일꾼 스프라이트 (web/sprites/)

일꾼 보드(`/workers.js`)가 읽는 픽셀 스프라이트시트. **이 폴더가 비어 있으면 종별 이모지로 그린다** — 스프라이트는 선택 사항이다.

## 파일

- `index.json` — 쓸 종 목록. 순서가 곧 배정표다(워커 id 의 FNV-1a 해시 % 종 수 → 종). **순서를 바꾸면 일꾼 모습이 바뀐다** — 새 종은 끝에 붙인다.
  ```json
  { "species": ["peon", "mechanic", "dwarf", "farmer", "clerk", "wizard", "robot", "chef"] }
  ```
- `<종>.png` — 스프라이트시트 한 장(투명 배경, 32px 그리드).
- `<종>.json` — 프레임 좌표.
  ```json
  { "image": "peon.png", "size": [160, 160], "frame": [32, 32], "fps": 4,
    "states": { "working":       [[0,0],[32,0],[64,0]],
                "waiting_input": [[0,32],[32,32]],
                "reply_ready":   [[0,64],[32,64]],
                "delegating":    [[0,96],[32,96],[64,96]],
                "gone":          [[0,128]] } }
  ```
  `size` = 시트 전체 픽셀, `frame` = 한 칸, `states` = 상태별 프레임 왼쪽 위 좌표(픽셀). 없는 상태는 `working` 프레임을 쓴다.

화면 크기(44px 타일·40px 카드)로는 `image-rendering: pixelated` 로 확대·축소한다. 원본을 고해상도로 뽑아 32px 로 줄이는 절차는 만드는 쪽 몫이다.
