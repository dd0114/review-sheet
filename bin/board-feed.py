#!/usr/bin/env python3
"""board-feed — 진행판(review-sheet /board) 생산자. GitHub 이슈·PR 을 읽어 board.json 을 쓴다.

Python 3 표준 라이브러리 + `gh` CLI 만 쓴다. 쓰기는 `review-sheet board -` (검증 + 원자적 교체).

칸 (판정 순서대로):
  - 하는 중(doing): 열린 이슈 중 ① 이 이슈를 가리키는 열린 PR 이 있거나 ② `doingLabels` 라벨이 붙었거나
      ③ (`doingIfAssigned` 를 켰을 때) 담당자가 있는 것. 단 안 풀린 「무엇을 기다림」 노트가 있으면 기다림.
  - 기다림(wait): 마지막 인계 노트(댓글)의 「무엇을 기다림: …」이 아직 안 풀린 것.
      PR #N → 머지되면, 이슈 #N 닫힘 → 닫히면, #N 들어간 글 → 적힌 번호가 다 닫힘·머지면, 시트 <id> → 제출되면,
      파일 <경로> → 생기면, YYYY-MM-DD [HH:MM] → 그때부터, hero <사유>·상시 → 사람만 풀음. 없음/- = 기다리는 것 없음.
  - 배포 대기(ship): main 계열 브랜치로 머지된 PR 이 있는데 아직 끝이 아닌 열린 이슈.
      liveUrl(배포본 version.json, {"sha": "<커밋>"}) 이 있으면 머지 커밋이 그 sha 에 들어갔나(gh compare ahead/identical)로 '실림'을 본다.
      닫힌 이슈도 최신 머지 PR 이 아직 안 실렸으면 배포 대기.
  - 끝(done): 최근 doneHours(기본 48) 안에 닫힌 이슈.
  - 할 일(todo): 그 밖의 열린 이슈(에픽·로드맵 묶음 제외). 우선도 = 라벨 P0~P3.

자동 닫기(기본 꺼짐 — autoclose: true 일 때만): 실렸고(liveUrl 필요) 열린 PR 이 없고 계속 라벨이 없고
  머지 뒤 노트가 막지 않으면(딱 「없음」, 또는 「남은 일 없음/닫히게 둠」+ 남은 일 표시 없음) 이슈를 댓글과 함께 닫는다.
  한 번에 autocloseMax(기본 5)개까지. 사람이 다시 연 이슈는 다시 안 닫는다(다시 연 뒤 '끝' 노트를 적었으면 닫음).
  꺼져 있으면 <stateDir>/autoclose-dry.json 에 닫을 목록(would_close)과 못 닫는 후보(blocked, 사유)만 적는다.
칸반(선택, 레포마다 kanban: true): GitHub 프로젝트 '<group> 칸반' 의 Status 열(할 일/진행 중/기다림/배포 대기/끝)에 같은 판정을 쓴다.

실행: board-feed.py --config board-feed.json [--once] [--dry]
  --once 한 번만 · --dry 판 JSON 을 stdout 에, 한 번만(쓰기·닫기·칸반·상태 파일 없음) · 기본은 interval 초마다 반복.
"""
import argparse, json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS = {
    'title': '진행판',
    'repos': [],                      # [{group, repo: 'owner/name', liveUrl?: '<…/version.json>', kanban?: bool}]
    'mainBranches': ['main', 'master'],
    'continueLabel': '계속',
    'doingLabels': ['doing', '진행 중'],
    'doingIfAssigned': False,
    'skipLabels': ['epic'],
    'doneHours': 48,
    'autoclose': False,
    'autocloseMax': 5,
    'interval': 180,
    'stateDir': '~/.review-sheet/board-feed',
}
CFG = dict(DEFAULTS)
STATE = os.path.expanduser(DEFAULTS['stateDir'])
DRY = False
MERGED_FULL_EVERY = int(os.environ.get('BOARD_MERGED_FULL_EVERY', str(6 * 3600)))   # 머지 PR 전부 다시 읽는 간격 — 사이엔 최근 100개만
MERGED_FULL_RETRY = int(os.environ.get('BOARD_MERGED_FULL_RETRY', '3600'))          # 전부 읽기가 실패하면 이만큼 쉬고 다시


def load_config(path=None, env=os.environ):
    """기본값 ← 설정 파일(JSON) ← 환경변수. 환경변수: BOARD_REPOS='group=owner/repo[@liveUrl] …', BOARD_AUTOCLOSE=on|off,
    BOARD_MAIN_BRANCHES=a,b, BOARD_CONTINUE_LABEL, BOARD_DONE_HOURS, BOARD_CLOSE_MAX, BOARD_INTERVAL, BOARD_STATE_DIR."""
    c = json.loads(json.dumps(DEFAULTS))
    path = path or env.get('BOARD_FEED_CONFIG')
    if path:
        with open(os.path.expanduser(path), encoding='utf-8') as f:
            j = json.load(f)
        if not isinstance(j, dict):
            raise ValueError('설정 파일은 JSON 객체여야 함')
        c.update(j)
    if env.get('BOARD_REPOS', '').strip():
        c['repos'] = []
        for pair in env['BOARD_REPOS'].split():
            g, _, rest = pair.partition('=')
            repo, _, live = rest.partition('@')
            c['repos'].append({'group': g, 'repo': repo, 'liveUrl': live or None})
    for k, e, conv in (('autoclose', 'BOARD_AUTOCLOSE', env_bool),
                       ('mainBranches', 'BOARD_MAIN_BRANCHES', lambda v: [x.strip() for x in v.split(',') if x.strip()]),
                       ('continueLabel', 'BOARD_CONTINUE_LABEL', str), ('doneHours', 'BOARD_DONE_HOURS', env_int),
                       ('autocloseMax', 'BOARD_CLOSE_MAX', env_int), ('interval', 'BOARD_INTERVAL', env_int), ('stateDir', 'BOARD_STATE_DIR', str)):
        if env.get(e, '').strip():
            try:
                c[k] = conv(env[e].strip())
            except ValueError:
                raise ValueError(f'{e}={env[e]!r} — 형식이 틀림')
    check_config(c)
    return c


def env_bool(v):
    v = v.lower()
    if v in ('on', '1', 'true'):
        return True
    if v in ('off', '0', 'false'):
        return False
    raise ValueError(v)


def env_int(v):
    if not re.fullmatch(r'\d+', v):
        raise ValueError(v)
    return int(v)


def check_config(c):
    """형식이 틀리면 ValueError — 자동 닫기는 진짜 true 일 때만 켜지게(\"false\" 문자열·1 은 거부)."""
    bad = lambda k, want: ValueError(f'{k} 는 {want} 이어야 함 — 지금 {c.get(k)!r}')
    if not isinstance(c.get('autoclose'), bool):
        raise bad('autoclose', 'true/false')
    if not isinstance(c.get('doingIfAssigned'), bool):
        raise bad('doingIfAssigned', 'true/false')
    for k in ('autocloseMax', 'doneHours', 'interval'):
        if not isinstance(c.get(k), int) or isinstance(c.get(k), bool) or c[k] < (1 if k == 'interval' else 0):
            raise bad(k, '0 이상 정수' if k != 'interval' else '1 이상 정수')
    for k in ('mainBranches', 'doingLabels', 'skipLabels'):
        if not isinstance(c.get(k), list) or not all(isinstance(x, str) and x for x in c[k]):
            raise bad(k, '문자열 목록')
    for k in ('title', 'continueLabel', 'stateDir'):
        if not isinstance(c.get(k), str) or not c[k]:
            raise bad(k, '빈 칸 아닌 문자열')
    if not isinstance(c.get('repos'), list):
        raise bad('repos', '목록')
    for r in c['repos']:
        if not isinstance(r, dict) or not re.fullmatch(r'[\w.-]+/[\w.-]+', str(r.get('repo') or '')) or not re.fullmatch(r'[\w.-]{1,40}', str(r.get('group') or '')):
            raise ValueError(f'repos 항목이 틀림: {r} — {{"group": "<이름>", "repo": "owner/name"}}')
        if r.get('liveUrl') is not None and not (isinstance(r['liveUrl'], str) and re.match(r'https?://', r['liveUrl'])):
            raise ValueError(f'{r["group"]}: liveUrl 은 http(s) 주소 — 지금 {r["liveUrl"]!r}')
        if not isinstance(r.get('kanban', False), bool):
            raise ValueError(f'{r["group"]}: kanban 은 true/false — 지금 {r["kanban"]!r}')


def configure(c):
    global CFG, STATE
    CFG, STATE = c, os.path.expanduser(c['stateDir'])


def rs_cmd():
    """review-sheet 실행 — REVIEW_SHEET_BIN, 없으면 PATH 의 review-sheet, 없으면 옆의 review-sheet.mjs."""
    if os.environ.get('REVIEW_SHEET_BIN'):
        return [os.environ['REVIEW_SHEET_BIN']]
    if shutil.which('review-sheet'):
        return ['review-sheet']
    return ['node', os.path.join(HERE, 'review-sheet.mjs')]


def sh(*a, inp=None, timeout=60):
    try:
        return subprocess.run(a, input=inp, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ''


def now():
    return datetime.now(timezone.utc)


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def log(msg):
    print(f'[board-feed] {iso(now())} {msg}', file=sys.stderr, flush=True)


def jload(p, d):
    try:
        with open(p) as f:
            v = json.load(f)
        return v if isinstance(v, type(d)) else d
    except Exception:
        return d


def jsave(p, v):
    if DRY:   # --dry 는 상태 파일도 안 쓴다
        return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(v, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


# ── 인계 노트 읽기 ──
# 「무엇을 기다림: …」(줄 어디서든) 또는 줄 머리의 「기다림: …」 — 굵게·괄호 날짜 「기다림 (10-25):」도.
# 줄 중간은 「… · 다음 행동: … · 기다림: 없음」처럼 ' · ' 뒤에 온 것만 — 글 속 「기다림:」은 노트 아님.
WAIT_RE = re.compile(r'(?:무엇을\s*기다림|^[\s>*_`\-·•]*기다림|\s·\s*[*_`]*기다림)[*_`\s]*(?:\([^)\n]{0,20}\))?[*_`\s]*[:：|]\s*(.+)')
TAIL_RE = re.compile(r'\s·\s*(?:다음|담당|P[0-3])')
NEXT_RE = re.compile(r'다음(?:\s*행동)?\s*[:：]\s*([^\n]+?)\s*(?:·\s*기다림|$|\n)', re.M)
# 머지 뒤 노트가 '끝' 이라고 적은 것 — 기다림 줄과 그 위아래 한 줄에서만, 묻는 줄은 빼고.
DONE_RE = re.compile(r'남은\s*일\s*(?:은\s*)?없음|닫히게\s*둠|닫아도\s*(?:됨|된다|좋음|좋다)(?![가-힣])')
ASK_RE = re.compile(r'[?？]|물어|물음|여쭤|(?:을|ㄹ)지\b|할까|될까|좋을')
# 남은 일 표시 — 있으면 「없음」·「남은 일 없음」이어도 안 닫음(「없음 · 다음: 2단계 UI」 「없음. 2단계는 다음 PR 에서」)
REMAIN_RE = re.compile(r'다음\s*[:：]|남은\s*(?:작업|것)|[가-힣]\s*남음|\d\s*단계|다음\s*PR|후속\s*(?:PR|작업|단계)')
REMAIN_ANY = re.compile(r'남은\s*(?:작업|것)\s*[:：]|[가-힣]\s*남음')   # 댓글 어디에든 있으면 남은 일
NONE_EXACT = re.compile(r'(?:없음|없다|-|—)\.?')
# 「배포본·라이브 확인」만 기다리는 노트 — 노트 전체가 그 말일 때만. 실리면 끝으로 본다(확인은 실림이 대신함).
# '오베' = 공개 시험판(배포본)을 줄여 부르는 말 — 이미 쓰인 노트와 맞추려고 남겨 둔 낱말.
CONFIRM_RE = re.compile(r'^\s*(?:hero\s*)?(?:오베|라이브|배포)?\s*(?:확인|sign-?off)\s*(?:\(이슈\s*열어\s*둠\))?\s*(?:[—\-]\s*(?P<tail>[^\n]*))?$', re.I)


def wait_text(comments):
    """댓글 본문들(오래된 것부터) 중 마지막 인계 노트의 「무엇을 기다림」 글. 노트가 없으면 None."""
    for body in reversed(comments):
        for line in (body or '').splitlines():
            m = WAIT_RE.search(line)
            if m:
                return TAIL_RE.split(m.group(1))[0].strip().strip('*_` |').strip()
    return None


def parse(text):
    """「무엇을 기다림」 글 → (kind, arg). kind: none·human·keep·sheet·pr·issue·file·date·refs·unknown."""
    t = (text or '').strip()
    if not t or re.fullmatch(r'(없음|없다|-|—|x|none|n/a)\.?', t, re.I) or (re.match(r'(없음|없다)(?![\w])', t) and not re.search(r'시트|PR\s*#|이슈\s*#|날짜|대기|기다', t[2:])):
        return 'none', ''
    if re.match(r'(상시|기록)(?![\w])', t):   # 일이 아니라 기록 이슈
        return 'keep', ''
    m = re.search(r'이슈\s*#?(\d+)\s*닫', t)
    if m:
        return 'issue', m.group(1)
    m = re.search(r'시트\s*[`\'"]?([A-Za-z0-9][\w.-]*)', t)
    if m:
        return 'sheet', m.group(1)
    m = re.search(r'\bPR\s*#?(\d+)', t, re.I)
    if m:
        return 'pr', m.group(1)
    m = re.search(r'파일\s*[`\'"]?([~/][^\s`\'"]+)', t)
    if m:
        return 'file', m.group(1)
    if re.search(r'안\s*막힘', t):   # 「… 해소 → 재개 가능(이제 안 막힘)」
        return 'none', ''
    if re.match(r'hero(?![A-Za-z0-9_])', t, re.I):   # 사람 말로만 풀림
        return 'human', re.sub(r'^hero\s*[:：-]?\s*', '', t, flags=re.I)
    m = re.match(r'^(?:날짜\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?![\d:])', t)
    if m:
        arg = m.group(1) + (' ' + m.group(2) if m.group(2) else '')
        try:
            time.strptime(arg, '%Y-%m-%d %H:%M' if m.group(2) else '%Y-%m-%d')
            return 'date', arg
        except ValueError:
            pass
    m = re.search(r'(?<![\d-])(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?![\d:])', t)   # 「(10-27 09:00)」 — 올해로 읽음
    if m:
        y = time.localtime().tm_year + (1 if int(m.group(1)) < time.localtime().tm_mon - 6 else 0)
        arg = '%d-%02d-%02d %02d:%s' % (y, int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4))
        try:
            time.strptime(arg, '%Y-%m-%d %H:%M')
            return 'date', arg
        except ValueError:
            pass
    # 「이슈 #31」「#30 머지」「#29 다음 차례」 — 번호들이 다 끝나면 풀림. 「owner/repo#5」 같은 남의 레포 번호는 안 셈
    refs = list(dict.fromkeys(re.findall(r'(?<![\w/.-])#(\d+)(?!\d)', t)))
    if refs:
        return 'refs', ','.join(refs)
    return 'unknown', t


def wait_of(i):
    """가장 최근 인계 노트 → (기다림, 다음, 적은 시각, 댓글 본문). 없으면 None."""
    for c in reversed(i.get('comments') or []):
        b = c.get('body') or ''
        t = wait_text([b])
        if t is not None:
            n = NEXT_RE.search(b)
            return t, (n.group(1).strip(' ·') if n else ''), c.get('createdAt') or '', b
    return None


def confirm_only(w):
    """머지 뒤 노트가 「확인」 기다림뿐인가 — 꼬리(— …)는 배포본에 들어갔다는 말만 허용."""
    m = CONFIRM_RE.match(w[0])
    if not m or w[1] or REMAIN_RE.search(w[0]):
        return False
    tail = m.group('tail')
    return tail is None or (bool(re.search(r'오베|라이브|배포', tail)) and bool(re.search(r'들어감|실림|반영|나감', tail))
                            and not re.search(r'단계|범위|남(?:은|음)|후속|다음', tail))


def note_ctx(b):
    """댓글에서 기다림 줄과 그 위아래 한 줄 — '끝' 말을 찾는 곳."""
    ls = (b or '').splitlines()
    for k, line in enumerate(ls):
        if WAIT_RE.search(line):
            return ls[max(0, k - 1):k + 2]
    return []


def finished_note(w):
    """머지 뒤 노트가 '끝(남은 일 없음)'을 말하나 — 값이 딱 「없음」(다음 행동 없이) 이거나,
    기다림 줄 ±1 줄에 묻지 않는 「남은 일 없음/닫히게 둠」. 남은 일 표시가 있으면 아님."""
    ctx = note_ctx(w[3])
    if any(REMAIN_RE.search(l) for l in ctx) or REMAIN_RE.search(w[0]) or REMAIN_ANY.search(w[3] or '') or w[1]:
        return False
    return bool(NONE_EXACT.fullmatch(w[0].strip())) or any(DONE_RE.search(l) and not ASK_RE.search(l) for l in ctx)


# ── 노트 풀림 판정 (gh 상태는 _refs 캐시) ──
_refs = {}   # {키: {'state', 'ts'}}


def gh_issue_state(repo, n):
    try:
        return json.loads(sh('gh', 'issue', 'view', str(n), '-R', repo, '--json', 'state', timeout=30)).get('state')
    except ValueError:
        return None


def gh_pr_state(repo, n):
    try:
        return json.loads(sh('gh', 'pr', 'view', str(n), '-R', repo, '--json', 'state', timeout=30)).get('state')
    except ValueError:
        return None


def gh_ref_state(repo, n):
    """#N 하나 — 이슈면 OPEN/CLOSED, PR 이면 OPEN/MERGED/UNMERGED. 이슈 API 하나로 둘 다 본다."""
    out = sh('gh', 'api', f'repos/{repo}/issues/{n}', '-q', '[.state, (.pull_request != null), (.pull_request.merged_at // "")] | @tsv', timeout=30).strip()
    p = out.split('\t')
    if len(p) < 2 or p[0] not in ('open', 'closed'):
        return None
    if p[0] == 'open':
        return 'OPEN'
    if p[1] == 'true':
        return 'MERGED' if len(p) > 2 and p[2] else 'UNMERGED'
    return 'CLOSED'


issue_state, pr_state, ref_state = gh_issue_state, gh_pr_state, gh_ref_state   # 시험에서 바꿔 끼움


def gh_keys(kind, arg, repo, own):
    if kind == 'issue':
        return [f'{repo}#issue{arg}']
    if kind == 'pr':
        return [f'{repo}#{arg}']
    if kind == 'refs':
        return [f'{repo}#ref{n}' for n in arg.split(',') if n and n != own]
    return []


def _cached(key, fn, ttl):
    c = _refs.get(key)
    if not c or time.time() - c.get('ts', 0) >= ttl:
        c = _refs[key] = {'state': fn(), 'ts': time.time()}
    return c['state']


def resolved(kind, arg, no, group, repo, sheet_state, ttl):
    """(풀렸나, 지금 상태 한 마디)."""
    if kind == 'none':
        return True, ''
    if kind == 'sheet':
        sid = arg if arg in sheet_state or f'{group}-{arg}' not in sheet_state else f'{group}-{arg}'   # 그룹 접두어를 빠뜨린 이름도
        s = sheet_state.get(sid)
        return s == '제출됨', '' if s == '제출됨' else f'시트 {sid} ' + (s or '목록에 없음')
    if kind == 'keep':
        return False, '상시(기록)'
    if kind == 'human':
        return False, arg[:40] or 'hero'
    if kind == 'issue':
        st = _cached(f'{repo}#issue{arg}', lambda: issue_state(repo, arg), ttl)
        return st == 'CLOSED', f"이슈 #{arg} {st or '확인 안 됨'}"
    if kind == 'pr':
        st = _cached(f'{repo}#{arg}', lambda: pr_state(repo, arg), ttl)
        return st == 'MERGED', f"PR #{arg} {st or '확인 안 됨'}"
    if kind == 'refs':   # 적힌 #N 이 모두 닫힌 이슈·머지된 PR 이면 풀림 — 자기 번호는 뺌
        nos = [n for n in arg.split(',') if n and n != str(no)]
        if not nos:
            return False, '못 읽음'
        left = []
        for n in nos:
            st = _cached(f'{repo}#ref{n}', lambda n=n: ref_state(repo, n), ttl)
            if st not in ('CLOSED', 'MERGED'):
                left.append(f"#{n} {st or '확인 안 됨'}")
        return not left, ' · '.join(left)
    if kind == 'file':
        return os.path.exists(os.path.expanduser(arg)), f'파일 {arg} 아직 없음'
    if kind == 'date':
        threshold = time.mktime(time.strptime(arg, '%Y-%m-%d %H:%M' if len(arg) > 10 else '%Y-%m-%d'))
        return time.time() >= threshold, '날짜 ' + arg[5:]
    return False, '못 읽음'


def note_open(i, w, group, repo, sheet_state, online=False):
    """인계 노트 「무엇을 기다림」이 아직 안 풀렸나 → (안 풀림, 한 마디). 노트 없음·'없음'·풀린 노트 = (False, …).
    gh 는 online(조회 주기의 prefetch)일 때만 — build 는 캐시만 읽고, 캐시에 없으면 '확인 차례'(안 풀림 = 안 닫음)."""
    if not w:
        return False, ''
    kind, arg = parse(w[0])
    if kind == 'none':
        return False, ''
    if kind == 'unknown':
        return True, '풀림 조건 모름'
    if not online and any(k not in _refs for k in gh_keys(kind, arg, repo, str(i['number']))):
        return True, '확인 차례'
    try:
        done, why = resolved(kind, arg, i['number'], group, repo, sheet_state, CFG['interval'] if online else 10 ** 12)
    except Exception:
        return True, '확인 안 됨'
    return not done, why


def prefetch(issues_, group, repo, sheet_state):
    """조회 주기에 노트가 가리키는 PR·이슈 상태를 _refs 에 미리 — build 안에서 gh 를 안 부르게. 같은 번호는 한 번만."""
    for i in issues_ or []:
        w = wait_of(i)
        if w:
            note_open(i, w, group, repo, sheet_state, online=True)


def wait_note(w, why):
    return f"기다림: {w[0][:120]}" + (f" — {why}" if why and why not in w[0] else '')


def sheet_states():
    """{시트 id: 상태} — `review-sheet ls` (읽기만)."""
    out = {}
    for f in (l.split('\t') for l in sh(*rs_cmd(), 'ls').splitlines()):
        if len(f) >= 3:   # 이름 \t id \t 대기|제출됨 … — 노트엔 이름도 id 도 온다
            out[f[0].lstrip('🔥')] = out[f[1]] = f[2]
    return out


# ── GitHub 읽기 ──
COMMENTS_MAX = 100   # gh issue list --json comments 가 주는 상한
_comments = {}       # {(repo, 번호): ((댓글 수, 이슈 updatedAt), 댓글들)} — 둘 다 같으면 다시 안 읽음(지우고 하나 더해 수가 같아도 updatedAt 이 바뀜)


def all_comments(repo, n, updated=''):
    """댓글 100개 이상인 이슈의 댓글 전부 [{body, createdAt}] — gh api 페이지 넘김. 못 읽거나 수가 모자라면 None(그 이슈 닫기 막음)."""
    cnt = comment_count(repo, n)
    if cnt is None:
        return None
    hit = _comments.get((repo, n))
    if hit and hit[0] == (cnt, updated):
        return hit[1]
    try:
        r = subprocess.run(['gh', 'api', '--paginate', f'repos/{repo}/issues/{n}/comments?per_page=100', '--jq', '.[] | {body, createdAt: .created_at}'],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return None
        out = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
    except Exception:
        return None
    if len(out) < cnt or not all(isinstance(c, dict) for c in out):
        return None
    _comments[(repo, n)] = ((cnt, updated), out)
    return out


def issues(repo):
    """(열린 이슈[댓글 포함], 최근 닫힌 이슈) — gh 실패면 (None, None). 댓글만 못 읽으면 comments=None."""
    since = (now() - timedelta(hours=CFG['doneHours'])).strftime('%Y-%m-%d')
    def q(*a):
        v = json.loads(sh('gh', 'issue', 'list', '-R', repo, '--limit', '300', '--json',
                          'number,title,labels,body,url,updatedAt,closedAt,assignees', *a) or 'null')
        if not isinstance(v, list):
            raise ValueError('gh issue list 실패')
        return v
    try:
        op = q('--state', 'open')
        try:
            raw = sh('gh', 'issue', 'list', '-R', repo, '--state', 'open', '--limit', '300', '--json', 'number,comments', timeout=120)
            cm = {i['number']: i.get('comments') or [] for i in json.loads(raw)} if raw.strip() else None
        except Exception:
            cm = None
        for i in op:   # 댓글을 못 읽었으면 None — 기다림 노트를 모르니 자동 닫기 안 함
            i['comments'] = None if cm is None else cm.get(i['number'])   # 목록에 없는 이슈도 None(못 읽음)
            if i['comments'] is not None and len(i['comments']) >= COMMENTS_MAX:   # gh 는 앞 100개만 준다 — 그 이슈만 전부 다시
                i['comments'] = all_comments(repo, i['number'], i.get('updatedAt') or '')
                if i['comments'] is None:
                    i['_unread'] = f'댓글 {COMMENTS_MAX}개 이상 — 전부 못 읽음'
            elif i['comments'] is None and cm is not None:
                i['_unread'] = '댓글 목록에 없음'
        return op, q('--state', 'closed', '--search', f'closed:>={since}')
    except Exception:
        return None, None


def pr_refs(p):
    """열린 PR 이 가리키는 이슈 — 제목 '(#N …)' 또는 본문 Closes/Fixes/Resolves/Refs #N. 열린 PR(닫기 막기)용 — 넓게 읽을수록 안전."""
    text = f"{p.get('title') or ''}\n{p.get('body') or ''}"
    return set(re.findall(r'\(#(\d+)(?:\s[^()]*)?\)', p.get('title') or '')) | set(re.findall(r'(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b[:\s]*#(\d+)(?!\d)', text))


# 닫기를 움직이는 머지 PR 연결: 제목 '(#N)' · '(Refs #N)' · 단계 표시 '(#N ②③)' '(#N 1/3)' '(#N 7·8)' '(#N 6a)'
# + GitHub 이 Closes/Fixes/Resolves 로 연결한 이슈(closingIssuesReferences). '(#N 조사용)' '(#N follow-up)' 은 보기용(related)만.
STEP = r'(?:[①-⑳]+|\d+[a-z]?(?:\s*[/·,~\-]\s*\d+[a-z]?)*)'
CLOSE_TITLE_RE = re.compile(r'\((?:refs?\s+)?#(\d+)(?:\s+' + STEP + r')?\)', re.I)
ANY_TITLE_RE = re.compile(r'\(#(\d+)(?:\s[^()]*)?\)')


def close_refs(p, repo=None):
    """머지 PR 이 '이 이슈의 PR' 이라고 확실히 적은 번호들 — 닫기·배포 대기는 이것만 본다."""
    out = {int(n) for n in CLOSE_TITLE_RE.findall(p.get('title') or '')}
    for r in p.get('closingIssuesReferences') or []:
        rr = r.get('repository') or {}
        if not repo or f"{(rr.get('owner') or {}).get('login')}/{rr.get('name')}" == repo:
            if isinstance(r.get('number'), int):
                out.add(r['number'])
    return out


OPEN_PR_LIMIT = 200


def mention_refs(p, repo):
    """닫기 막기용 — 열린 PR 이 어디서든 가리킨 같은 레포 번호: 제목·본문의 #N(남의 레포 owner/x#N 은 빼고 이 레포 owner/name#N 은 셈),
    이 레포 이슈·PR 주소(github.com/owner/name/issues|pull/N), GH-N, 브랜치 이름의 숫자 묶음(fix/x-12 · fix-issue12 → 12), GitHub Closes 연결. 넓게 — 아니면 열린 일을 닫는다."""
    text = f"{p.get('title') or ''}\n{p.get('body') or ''}"
    out = {int(n) for n in re.findall(r'(?<![\w/.-])#(\d+)(?!\d)', text)}
    out |= {int(n) for n in re.findall(r'(?<![\w.-])' + re.escape(repo) + r'#(\d+)(?!\d)', text, re.I)}
    out |= {int(n) for n in re.findall(r'github\.com/' + re.escape(repo) + r'/(?:issues|pull)/(\d+)(?!\d)', text, re.I)}
    out |= {int(n) for n in re.findall(r'(?<![\w-])GH-(\d+)(?!\d)', text, re.I)}
    out |= {int(n) for n in re.findall(r'(?<![0-9])(\d+)(?![0-9])', p.get('headRefName') or '')}   # 앞 글자 허용(fix-issue12 → 12)
    return out | close_refs({'closingIssuesReferences': p.get('closingIssuesReferences')}, repo)


def open_prs(repo):
    """{'by': {이슈: [PR]}(하는 중 — pr_refs·Closes 연결), 'any': {이슈: [PR]}(닫기 막기 — mention_refs), 'complete': 다 읽었나}.
    gh 실패면 None. 상한(200)만큼 왔으면 다 못 읽은 것 — complete False 면 그 레포는 안 닫는다."""
    try:
        prs = json.loads(sh('gh', 'pr', 'list', '-R', repo, '--state', 'open', '--limit', str(OPEN_PR_LIMIT), '--json',
                            'number,title,body,headRefName,closingIssuesReferences') or 'null')
    except Exception:
        return None
    if not isinstance(prs, list):
        return None
    by, any_ = {}, {}
    for p in prs:
        if not isinstance(p, dict):
            continue
        for n in {int(x) for x in pr_refs(p)} | close_refs({'closingIssuesReferences': p.get('closingIssuesReferences')}, repo):
            by.setdefault(n, []).append(p.get('number'))
        for n in mention_refs(p, repo):
            any_.setdefault(n, []).append(p.get('number'))
    return {'by': by, 'any': any_, 'complete': len(prs) < OPEN_PR_LIMIT}


def _ints(v):
    return [n for n in v if isinstance(n, int)] if isinstance(v, list) else []


def merged_prs(repo):
    """머지된 PR → ({이슈: 최신 PR}(닫기용 close_refs, main 계열 브랜치만), {이슈: 최신 PR}(보기용 — 넓게, 곁가지 포함)).
    PR 별 기록을 <stateDir>/merged.json 에 쌓아 오래된 머지도 남긴다 — MERGED_FULL_EVERY 마다 3000개까지 다시, 그 사이엔 최근 100개만.
    전부 읽기가 실패하면 MERGED_FULL_RETRY 동안 다시 안 함. 캐시가 깨졌으면 버리고 다시."""
    cp = os.path.join(STATE, 'merged.json')
    allc = jload(cp, {})
    c = allc.get(repo) if isinstance(allc.get(repo), dict) else {}
    known = c.get('prs') if isinstance(c.get('prs'), dict) else {}
    known = {k: v for k, v in known.items() if isinstance(v, dict) and str(k).isdigit()}
    t = time.time()
    num = lambda k: c.get(k) if isinstance(c.get(k), (int, float)) else 0
    stale_fmt = any('base' not in v for v in known.values())
    full = (not known or stale_fmt or t - num('full') >= MERGED_FULL_EVERY) and t - num('fullTry') >= MERGED_FULL_RETRY
    if full:
        c['fullTry'] = t
    try:
        prs = json.loads(sh('gh', 'pr', 'list', '-R', repo, '--state', 'merged', '--limit', '3000' if full else '100', '--json',
                            'number,title,mergedAt,mergeCommit,closingIssuesReferences,baseRefName', timeout=180 if full else 60) or 'null')
    except Exception:
        prs = None
    if isinstance(prs, list):
        if full:
            known, c['full'] = {}, t
        for p in prs:
            if not isinstance(p, dict) or not isinstance(p.get('number'), int):
                continue
            known[str(p['number'])] = {'refs': sorted(close_refs(p, repo)), 'any': sorted(int(n) for n in ANY_TITLE_RE.findall(p.get('title') or '')),
                                       'mergedAt': p.get('mergedAt'), 'oid': (p.get('mergeCommit') or {}).get('oid'), 'base': p.get('baseRefName') or 'main'}
    c['prs'] = known
    allc[repo] = c
    try:
        jsave(cp, allc)
    except OSError:
        pass
    mains = set(CFG['mainBranches'])
    out, rel = {}, {}
    for k, p in known.items():
        pr = {'number': int(k), 'mergedAt': p.get('mergedAt') if isinstance(p.get('mergedAt'), str) else '', 'mergeCommit': {'oid': p.get('oid')}}
        main_ = p.get('base', 'main') in mains   # 에픽 base 같은 곁가지로 머지된 PR 은 main 에 안 들어감 — 보기용만
        for m, nos in ((out, _ints(p.get('refs')) if main_ else []), (rel, _ints(p.get('refs')) + _ints(p.get('any')))):
            for n in nos:
                if n not in m or pr['mergedAt'] > m[n]['mergedAt']:
                    m[n] = pr
    return out, rel


def live_sha(url):
    """배포본 version.json 의 sha. curl — urllib 기본 UA 는 일부 CDN 이 막는다."""
    try:
        sep = '&' if '?' in url else '?'
        d = json.loads(sh('curl', '-sf', '--max-time', '10', '-H', 'cache-control: no-cache', f'{url}{sep}t={int(time.time())}', timeout=20) or '{}')
        sha = (d.get('sha') or d.get('commit') or '') if isinstance(d, dict) else ''
        return sha if re.fullmatch(r'[0-9a-f]{7,40}', sha) else None
    except Exception:
        return None


_unshipped = {}   # {머지 커밋: 안 실렸다고 본 배포본 커밋}


def compare(repo, base, head):
    """gh api compare 의 status(ahead·identical·behind·diverged) — 실패(오류 코드·빈 출력)면 None."""
    try:
        r = subprocess.run(['gh', 'api', f'repos/{repo}/compare/{base}...{head}', '-q', '.status'], capture_output=True, text=True, timeout=60)
    except Exception:
        return None
    st = r.stdout.strip()
    return st if r.returncode == 0 and st in ('ahead', 'identical', 'behind', 'diverged') else None


def shipped(repo, live_url, merged, nos):
    """{이슈: 실린 커밋 7자리} — nos(열린·최근 닫힌 이슈)의 최신 머지 PR 이 배포본 커밋에 들어 있으면.
    liveUrl 이 없으면 {}(자동 닫기 없음). 배포본 커밋을 못 읽으면 None.
    캐시(shipped.json) = {머지 커밋: 그때 배포본 커밋} — 배포본 커밋이 바뀌면(되돌림 포함) 다시 비교한다.
    compare 가 실패하면 안 실림으로 보고 캐시하지 않는다(다음 주기에 다시)."""
    if not live_url:
        return {}
    live = live_sha(live_url)
    if not live:
        return None
    cp = os.path.join(STATE, 'shipped.json')
    seen = {k: v for k, v in jload(cp, {}).items() if isinstance(v, str)}
    keep, out = {}, {}
    for n, p in merged.items():
        if n not in nos:
            continue
        oid = (p.get('mergeCommit') or {}).get('oid')
        if not oid:
            continue
        if seen.get(oid) != live:
            if _unshipped.get(oid) == live:   # 안 실린 건 배포본 커밋이 바뀔 때만 다시 비교
                continue
            st = compare(repo, oid, live)
            if st not in ('ahead', 'identical'):
                if st:   # behind·diverged 로 확인된 것만 기억 — 오류는 기억 안 함
                    _unshipped[oid] = live
                continue
        keep[oid] = live
        out[n] = live[:7]
    jsave(cp, keep)
    return out


# ── 판정 ──
PRI_RE = re.compile(r'^(?:priority[:/ ]?)?(P[0-3])$', re.I)
# 에픽·로드맵 묶음만 뺀다: 라벨 skipLabels, 제목 머리 '[Epic]'·'Epic:'·'에픽 —', 단계 번호 없는 '로드맵'.
SKIP_HEAD = re.compile(r'^(?:\[[^\]]*\]\s*)*?(?:\[\s*(?:epic|에픽)\s*\]|(?:epic|에픽)(?:\s*[:：]|\s+[—\-]|\s*$))', re.I)
SKIP_TITLE = re.compile(r'로드맵(?!\s*\d)')


def labels(i):
    return {l.get('name', '') for l in i.get('labels') or []}


def priority(i):
    for n in labels(i):
        m = PRI_RE.match(n)
        if m:
            return m.group(1).upper()
    return None


def skip(i):
    t = i.get('title') or ''
    return bool(labels(i) & set(CFG['skipLabels'])) or bool(SKIP_HEAD.search(t) or SKIP_TITLE.search(t))


def tidy(t):
    return re.sub(r'^\[[^\]]+\]\s*', '', t or '')


def assignees(i):
    return [a.get('login') for a in i.get('assignees') or [] if isinstance(a, dict) and a.get('login')]


def close_block(i, open_pr):
    """자동 닫기를 막는 읽기 문제·열린 PR 언급 — 없으면 None."""
    if open_pr is None:
        return '열린 PR 목록 못 읽음'
    if not open_pr.get('complete'):
        return f'열린 PR 이 {OPEN_PR_LIMIT}개 이상(다 못 읽음)'
    prs = (open_pr.get('any') or {}).get(i['number'])
    if prs:
        return '열린 PR ' + ' '.join(f'#{n}' for n in prs) + ' 이 가리킴'
    if i.get('comments') is None:
        return i.get('_unread') or '댓글 못 읽음'
    return None


def doing_reason(i, open_pr):
    """하는 중 근거 — 열린 PR > doingLabels 라벨 > (doingIfAssigned) 담당자. 없으면 None."""
    prs = ((open_pr or {}).get('by') or {}).get(i['number'])
    if prs:
        return 'PR ' + ' '.join(f'#{n}' for n in prs) + ' 열림', '열린 PR 남음'
    lb = next((l for l in CFG['doingLabels'] if l in labels(i)), None)
    if lb:
        return f'`{lb}` 라벨', f'`{lb}` 라벨'
    if CFG['doingIfAssigned'] and assignees(i):
        return '담당 ' + ', '.join(assignees(i)), '담당자 있음'
    return None


def build(repos, cache):
    """repos = CFG['repos'], cache = {'sheets': {...}, 'groups': {group: {open, closed, merged, related, shipped, openpr}}}.
    카드에 붙는 내부 키: _close (repo, no, 댓글) = 자동 닫기 후보, _block (repo, no, 사유) = 실렸는데 못 닫음, _fin = 다시 연 뒤 '끝' 노트 시각."""
    cards, cont = [], CFG['continueLabel']
    sheet_state = cache.get('sheets') or {}
    for k in [k for k, v in _refs.items() if time.time() - v.get('ts', 0) > 86400]:
        del _refs[k]
    for r in repos:
        g, repo, has_live = r['group'], r['repo'], bool(r.get('liveUrl'))
        gc = (cache.get('groups') or {}).get(g) or {}
        open_, closed = gc.get('open'), gc.get('closed')
        merged, related = gc.get('merged') or {}, gc.get('related') or {}
        ship = gc.get('shipped')
        live_ok = ship is not None   # 배포본 커밋을 읽었나 — 못 읽었으면 닫힌 이슈는 그냥 끝
        ship = ship or {}
        open_pr = gc.get('openpr')
        for i in open_ or []:
            if skip(i):
                continue
            no, cid = i['number'], f"{g}#{i['number']}"
            pr, w = merged.get(no), wait_of(i)
            base = {'id': cid, 'title': tidy(i['title']), 'priority': priority(i), 'owner': assignees(i), 'group': g, 'url': i['url']}
            op, why = note_open(i, w, g, repo, sheet_state)
            sha = ship.get(no)
            hold = f" · 배포본 {sha} 실림 — 닫기 보류" if no in ship else ''
            dr = doing_reason(i, open_pr)
            if dr:   # 하는 중 — 단 안 풀린 기다림 노트가 있으면 기다림
                card = dict(base, status='doing', note=dr[0] + (f" · PR #{pr['number']} 머지" if pr else '') + hold, at=i['updatedAt'])
                if op:
                    card.update(status='wait', note=wait_note(w, why) + f' · {dr[0]}' + hold, at=w[2] or i['updatedAt'])
                if no in ship and pr:
                    card['_block'] = (repo, no, dr[1])
                cards.append(card)
                continue
            # 머지 뒤 적은 '기다림' 이 안 풀렸으면 노트가 이김(후속 단계 등 — 큰 이슈는 계속 라벨). 「없음」·풀린 노트는 막지 않는다.
            post = bool(pr) and bool(w) and w[2] >= (pr.get('mergedAt') or '')
            confirm = post and confirm_only(w)
            finished = post and not op and finished_note(w) and '상시' not in w[0]   # 「없음(상시)」 = 상시 이슈, 안 닫음
            if pr and (not post or finished or confirm):
                at = pr.get('mergedAt') or i['updatedAt']
                if cont in labels(i):
                    cards.append(dict(base, status='todo', note=f"{cont} — PR #{pr['number']} 머지, 다음 단계" + hold, at=at,
                                      **({'_block': (repo, no, f'`{cont}` 라벨')} if hold else {})))
                elif no in ship and not close_block(i, open_pr):   # 열린 PR·댓글을 다 못 읽었으면 닫지 않음
                    msg = (f"배포본 `{sha}` 에 PR #{pr['number']} 이 실려 끝으로 봅니다 — 진행판 생산자(board-feed)가 자동으로 닫음. "
                           f"남은 일이 있으면 다시 열고 `{cont}` 라벨을 붙여 주세요.")
                    cards.append(dict(base, status='ship', mode='idle', modeNote=f"배포본 {sha} 실림 · 자동 닫기 후보", at=at,
                                      _fin=w[2] if finished else '', _nc=len(i['comments']), _close=(repo, no, msg)))
                elif no in ship:   # 실렸는데 못 닫음 — 왜인지 카드에
                    why_not = close_block(i, open_pr)
                    cards.append(dict(base, status='ship', mode='idle', at=at, modeNote=f"PR #{pr['number']} 머지 · 배포본 {sha} 실림 — 닫기 보류: {why_not}",
                                      _block=(repo, no, why_not)))
                else:
                    cards.append(dict(base, status='ship', mode='idle', at=at,
                                      modeNote=f"PR #{pr['number']} 머지 · " + ('배포 대기' if has_live else '닫기 대기(자동 닫기 없음)')))
                continue
            if w:
                at = w[2] or i['updatedAt']
                if op:
                    cards.append(dict(base, status='wait', note=wait_note(w, why) + hold, at=at,
                                      **({'_block': (repo, no, '머지 뒤 기다림 노트 안 풀림')} if hold and pr else {})))
                elif parse(w[0])[0] != 'none':
                    cards.append(dict(base, status='todo', note=f"풀림 · {w[0][:80]}" + hold, at=at,
                                      **({'_block': (repo, no, '머지 뒤 노트에 남은 일')} if hold and pr else {})))
                else:
                    cards.append(dict(base, status='todo', note=((f"다음: {w[1]}" if w[1] else '') + hold).lstrip(' ·') or None, at=at,
                                      **({'_block': (repo, no, '머지 뒤 노트에 남은 일')} if hold and pr else {})))
                continue
            cards.append(dict(base, status='todo', at=i['updatedAt'],
                              note=f"관련 PR #{related[no]['number']} 머지(닫기 근거 아님)" if no in related else None))
        for i in closed or []:
            if skip(i):
                continue
            no = i['number']
            card = {'id': f"{g}#{no}", 'title': tidy(i['title']), 'status': 'done', 'priority': priority(i),
                    'owner': assignees(i), 'group': g, 'url': i['url'], 'at': i.get('closedAt')}
            pr = merged.get(no)
            if has_live and live_ok and pr and no not in ship:   # 닫혔어도 최신 머지 PR 이 아직 배포본에 없으면 배포 대기
                card.update(status='ship', mode='idle', modeNote=f"닫힘 — PR #{pr['number']} 배포 대기")
            cards.append(card)
    return {'title': CFG['title'], 'source': 'board-feed', 'updatedAt': iso(now()), 'cards': cards}


# ── 자동 닫기 ──
def comment_count(repo, no):
    """이슈의 지금 댓글 수(gh api .comments) — 못 읽으면 None."""
    out = sh('gh', 'api', f'repos/{repo}/issues/{no}', '-q', '.comments', timeout=30).strip()
    return int(out) if out.isdigit() else None


def reopened_after(repo, no, merged_at, fin_at=''):
    """그 머지 뒤 다시 열린 적 있나 — 사람이 다시 연 이슈는 옛 PR 로 다시 닫지 않는다. 못 읽으면 True(안 닫음).
    다시 연 뒤에 '끝(남은 일 없음)' 노트를 적었으면(fin_at) 그 다시 열기는 풀린 것으로 본다."""
    try:
        r = subprocess.run(['gh', 'api', f'repos/{repo}/issues/{no}/timeline', '--paginate', '-q', '.[] | select(.event=="reopened") | .created_at'],
                           capture_output=True, text=True, timeout=60)
    except Exception:
        return True
    if r.returncode != 0:
        return True
    return any(t.strip() > (merged_at or '') and not (fin_at and fin_at > t.strip()) for t in r.stdout.splitlines() if t.strip())


def autoclose(cards, on=None, groups=None):
    """_close 카드 — 켜져 있으면 이슈를 닫고 카드를 끝으로, 꺼져 있으면 목록만. groups = 이번 주기에 새로 읽은 그룹만(옛 캐시로 닫지 않음).
    실렸는데 못 닫는 카드(_block)도 사유와 함께 blocked 에. 결과 {at, on, would_close, blocked} 를 autoclose-dry.json 에 쓰고 돌려준다."""
    on = (CFG['autoclose'] is True) if on is None else on is True
    ap = os.path.join(STATE, 'autoclosed.json')
    done, dry, blocked, n = jload(ap, {}), [], [], 0
    cont = CFG['continueLabel']
    for c in cards:
        b = c.pop('_block', None)
        fin = c.pop('_fin', '')
        nc = c.pop('_nc', None)
        if b:
            blocked.append({'issue': f'{b[0]}#{b[1]}', 'title': c['title'], 'reason': b[2]})
        x = c.pop('_close', None)
        if not x or (groups is not None and c.get('group') not in groups):
            continue
        repo, no, msg = x
        key = f'{repo}#{no}'
        if not on:
            dry.append({'issue': key, 'title': c['title'], 'note': c.get('modeNote')})
            continue
        if key in done:   # 자동으로 닫았는데 사람이 다시 연 이슈 — 다시 안 닫음
            blocked.append({'issue': key, 'title': c['title'], 'reason': '자동으로 닫았다가 다시 열림'})
            c.update(status='todo', note=f'자동으로 닫았다가 다시 열림 — 남은 일이면 `{cont}` 라벨', mode=None, modeNote=None)
            continue
        if n >= CFG['autocloseMax']:
            continue
        got = comment_count(repo, no)
        if got is None or got != nc:   # 읽은 뒤 댓글이 늘었거나(새 노트) 다 못 읽음 — 다음 주기에 다시 판정
            blocked.append({'issue': key, 'title': c['title'], 'reason': f'댓글 수가 다름(읽음 {nc}, 지금 {got})'})
            continue
        if reopened_after(repo, no, c.get('at'), fin):
            blocked.append({'issue': key, 'title': c['title'], 'reason': '머지 뒤 다시 열림(또는 못 읽음)'})
            c.update(status='todo', note=f'머지 뒤 다시 열림 — 남은 일이면 `{cont}` 라벨', mode=None, modeNote=None)
            continue
        n += 1
        try:
            r = subprocess.run(['gh', 'issue', 'close', str(no), '-R', repo, '-c', msg], capture_output=True, text=True, timeout=60)
        except Exception:
            continue
        if r.returncode == 0:   # 닫힌 것만 적음 — 실패는 다음 주기에 다시
            done[key] = iso(now())
            c.update(status='done', at=iso(now()), mode=None, modeNote=None, note='배포본에 실려 자동으로 닫음')
    res = {'at': iso(now()), 'on': on, 'would_close': dry, 'blocked': blocked}
    jsave(ap, done)
    jsave(os.path.join(STATE, 'autoclose-dry.json'), res)
    return res


# ── 칸반 (선택) ── 그룹마다 GitHub 프로젝트 '<group> 칸반' 의 Status 열에 같은 판정을 쓴다. 손으로 옮긴 카드는 판정이 바뀔 때까지 그대로.
KANBAN_COLS = [('할 일', 'GRAY'), ('진행 중', 'BLUE'), ('기다림', 'YELLOW'), ('배포 대기', 'PURPLE'), ('끝', 'GREEN')]
KANBAN_REFRESH = 1800   # 프로젝트·항목 목록을 다시 읽는 간격(초)
_kb = {}


def kanban_col(c):
    return {'done': '끝', 'doing': '진행 중', 'wait': '기다림', 'ship': '배포 대기'}.get(c['status'], '할 일')


def kanban_setup(g, repo):
    """그룹의 칸반 프로젝트 — 없으면 만든다. Status 열 이름을 바꾸는 건 이 스크립트가 만든 프로젝트(kanban.json created)뿐.
    남이 만든 같은 이름 프로젝트에 열이 모자라면 건드리지 않고 그 그룹 칸반을 건너뛴다."""
    owner, title = repo.split('/')[0], f'{g} 칸반'
    kp = os.path.join(STATE, 'kanban.json')
    mine = jload(kp, {}).get('created')
    mine = [x for x in mine if isinstance(x, str)] if isinstance(mine, list) else []
    try:
        ps = json.loads(sh('gh', 'project', 'list', '--owner', owner, '--limit', '100', '--format', 'json') or '{}').get('projects') or []
        p = next((x for x in ps if x.get('title') == title and not x.get('closed')), None)
        if not p:
            p = json.loads(sh('gh', 'project', 'create', '--owner', owner, '--title', title, '--format', 'json') or 'null')
            if not p:
                return None
            mine.append(p['id'])
            jsave(kp, {'created': mine})
            sh('gh', 'project', 'link', str(p['number']), '--owner', owner, '--repo', repo)
        num = str(p['number'])
        fs = json.loads(sh('gh', 'project', 'field-list', num, '--owner', owner, '--format', 'json') or '{}').get('fields') or []
        f = next((x for x in fs if x.get('name') == 'Status'), None)
        if not f:
            return None
        opts = {o['name']: o['id'] for o in f.get('options') or []}
        if any(n not in opts for n, _ in KANBAN_COLS) and p['id'] not in mine:
            log(f"{g}: 프로젝트 '{title}' 의 Status 열이 {'/'.join(n for n, _ in KANBAN_COLS)} 가 아님 — 남이 만든 프로젝트라 안 바꿈, 칸반 건너뜀")
            return None
        if any(n not in opts for n, _ in KANBAN_COLS):   # 이 스크립트가 만든 새 프로젝트 기본 열(Todo…)을 칸반 열로
            sel = ','.join('{name:%s,color:%s,description:""}' % (json.dumps(n, ensure_ascii=False), c) for n, c in KANBAN_COLS)
            r = json.loads(sh('gh', 'api', 'graphql', '-f', 'f=' + f['id'], '-f',
                              'query=mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[%s]})'
                              '{projectV2Field{... on ProjectV2SingleSelectField{options{id name}}}}}' % sel) or 'null')
            opts = {o['name']: o['id'] for o in r['data']['updateProjectV2Field']['projectV2Field']['options']}
        items = {}
        for it in json.loads(sh('gh', 'project', 'item-list', num, '--owner', owner, '--limit', '3000', '--format', 'json', timeout=120) or '{}').get('items') or []:
            u = (it.get('content') or {}).get('url')
            if u:
                items[u] = (it['id'], it.get('status'))
        return {'owner': owner, 'num': num, 'pid': p['id'], 'fid': f['id'], 'opts': opts, 'items': items,
                'url': p.get('url') or f'https://github.com/users/{owner}/projects/{num}', 'at': time.time()}
    except Exception:
        return None


def kanban_sync(repos, cards):
    for r in repos:
        g, repo = r['group'], r['repo']
        kb = _kb.get(g)
        if not kb or time.time() - kb['at'] > KANBAN_REFRESH:
            kb = kanban_setup(g, repo) or kb
        if not kb:
            continue
        _kb[g] = kb
        for c in cards:
            u = c.get('url') or ''
            if c.get('group') != g or f'github.com/{repo}/issues/' not in u:
                continue
            col = kanban_col(c)
            iid, cur = kb['items'].get(u, (None, None))
            if cur == col:
                continue
            if not iid:
                res = json.loads(sh('gh', 'project', 'item-add', kb['num'], '--owner', kb['owner'], '--url', u, '--format', 'json') or 'null')
                if not res:
                    continue
                iid = res['id']
            sh('gh', 'project', 'item-edit', '--id', iid, '--project-id', kb['pid'], '--field-id', kb['fid'],
               '--single-select-option-id', kb['opts'][col])
            kb['items'][u] = (iid, col)


# ── 한 주기 ──
def refresh(repos, cache):
    """gh 로 그룹마다 다시 읽어 cache 에. → (새로 읽은 그룹, 댓글만 못 읽어 지난 댓글로 판정한 그룹(stale)).
    이슈 목록부터 못 읽으면 지난 캐시를 그대로 두고 refreshed 에서 뺀다 — 둘 다 이번 주기 자동 닫기·칸반 안 함."""
    refreshed, stale = set(), set()
    cache['sheets'] = sheet_states()
    groups = cache.setdefault('groups', {})
    for r in repos:
        g, repo = r['group'], r['repo']
        o, c = issues(repo)
        if o is None:
            log(f'{g} ({repo}) 이슈 못 읽음 — 지난 판정 유지')
            continue
        prev = groups.get(g) or {}
        if any(i.get('comments') is None and not i.get('_unread') for i in o):   # 댓글 조회만 실패(이슈 하나만 못 읽은 건 그 카드만 막음) — 지난 댓글로 노트를 읽어 기다림 칸이 통째로 빠지지 않게
            old = {i['number']: i.get('comments') for i in prev.get('open') or []}
            for i in o:
                if not i.get('_unread'):
                    i['comments'] = old.get(i['number'])
            stale.add(g)
            log(f'{g} 댓글 못 읽음 — 지난 댓글로 판정, 닫기·칸반 건너뜀')
        else:
            refreshed.add(g)
        gc = groups[g] = {'open': o, 'closed': c}
        gc['merged'], gc['related'] = merged_prs(repo)
        prefetch(o, g, repo, cache['sheets'])   # 노트가 가리키는 PR·이슈 상태 — build 는 캐시만
        gc['openpr'] = open_prs(repo)
        gc['shipped'] = shipped(repo, r.get('liveUrl'), gc['merged'], {i['number'] for i in o} | {i['number'] for i in c or []})
    return refreshed, stale


def tick(cache):
    repos = CFG['repos']
    refreshed, stale = refresh(repos, cache)
    board = build(repos, cache)
    res = autoclose(board['cards'], on=False if DRY else None, groups=refreshed)
    if not DRY:
        kanban_sync([r for r in repos if r.get('kanban') and r['group'] in refreshed], board['cards'])
    board['links'] = [{'label': f'{g} 칸반', 'url': kb['url']} for g, kb in _kb.items()]
    return board, res


def main(argv=None):
    global DRY
    ap = argparse.ArgumentParser(description='진행판(review-sheet /board) 생산자 — GitHub 이슈·PR → board.json')
    ap.add_argument('--config', help='설정 JSON (없으면 BOARD_FEED_CONFIG / 환경변수)')
    ap.add_argument('--once', action='store_true', help='한 번만')
    ap.add_argument('--dry', action='store_true', help='판 JSON 을 stdout 에 — 쓰기·닫기·칸반·상태 파일 없음')
    a = ap.parse_args(argv)
    try:
        configure(load_config(a.config))
    except (OSError, ValueError) as e:   # json.JSONDecodeError 도 ValueError
        print(f'board-feed: 설정 읽기 실패 — {e}', file=sys.stderr)
        return 2
    if not CFG['repos']:
        print('board-feed: repos 가 비었음 — 설정 파일의 repos 또는 BOARD_REPOS', file=sys.stderr)
        return 2
    DRY = a.dry
    cache = {}
    while True:
        try:
            board, res = tick(cache)
        except Exception as e:   # 한 주기 실패로 상주 생산자가 죽지 않게
            log(f'주기 실패 — {type(e).__name__}: {e}')
            if a.once or DRY:
                return 1
            time.sleep(CFG['interval'])
            continue
        if DRY:
            print(json.dumps(board, ensure_ascii=False, indent=1))
            counts = {s: sum(c['status'] == s for c in board['cards']) for s in ('todo', 'doing', 'wait', 'ship', 'done')}
            log(f"칸 {counts} · 자동 닫기 후보 {len(res['would_close'])} · 막힘 {len(res['blocked'])} (dry — 안 씀)")
        else:
            out = sh(*rs_cmd(), 'board', '-', inp=json.dumps(board, ensure_ascii=False)).strip()
            if not out:
                log('board 쓰기 실패 — review-sheet 를 못 찾았거나 형식 거부 (REVIEW_SHEET_BIN)')
            elif a.once:
                print(out)
            if a.once:
                return 0 if out else 1
        if DRY:   # --dry 는 늘 한 번
            return 0
        time.sleep(CFG['interval'])


if __name__ == '__main__':
    sys.exit(main())
