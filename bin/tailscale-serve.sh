#!/bin/sh
# review-sheet 를 폰에서 HTTPS 로 열기 — tailscale serve (tailnet 전용, funnel 아님) 로
#   https://<this-node>.<tailnet>.ts.net  →  http://127.0.0.1:5600
# 서버는 127.0.0.1 에만 바인딩한 채로 둔다(--lan/0.0.0.0 금지). 폰 마이크(getUserMedia)는 HTTPS 에서만 열린다.
#
#   bin/tailscale-serve.sh on | off | status
#   env: TS_SOCKET (기본 personal tailscaled 소켓), REVIEW_SHEET_PORT (기본 5600)
#
# 전제(hero 1회): Tailscale admin 콘솔 → DNS → HTTPS Certificates "Enable". 안 돼 있으면 on 이 멈추고 안내한다.
set -eu
SOCK="${TS_SOCKET:-$HOME/.local/state/hmb/tailscale-personal/tailscaled.sock}"
PORT="${REVIEW_SHEET_PORT:-5600}"
TS="tailscale --socket=$SOCK"

self() { $TS status --json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["Self"]["DNSName"].rstrip("."));print(" ".join(d.get("CertDomains") or []))'; }

case "${1:-status}" in
  on)
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || { echo "✗ review-sheet 가 127.0.0.1:$PORT 에서 안 뜬다 (launchctl kickstart -k gui/$(id -u)/com.review-sheet.inbox)"; exit 1; }
    info=$(self); host=$(echo "$info" | sed -n 1p); certs=$(echo "$info" | sed -n 2p)
    case " $certs " in *" $host "*) ;; *)
      echo "✗ HTTPS 인증서 미활성 — hero 체크리스트:"
      echo "  1) https://login.tailscale.com/admin/dns → HTTPS Certificates → Enable"
      echo "  2) 다시: $0 on"
      exit 2 ;;
    esac
    $TS serve --bg --https=443 "http://127.0.0.1:$PORT"
    echo "✓ https://$host/  → 127.0.0.1:$PORT  (tailnet 기기만 — 폰에 Tailscale 켜고 열 것)"
    ;;
  off) $TS serve --https=443 off; echo "✓ serve 해제" ;;
  status) $TS serve status; self | sed -n 1p ;;
  *) echo "usage: $0 on|off|status"; exit 2 ;;
esac
