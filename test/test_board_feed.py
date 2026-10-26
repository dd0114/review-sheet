"""board-feed.py — 진행판 칸 판정. gh 는 전부 바꿔 끼운다(네트워크 없음).
python3 -m unittest discover -s test -p 'test_*.py'"""
import sys
sys.dont_write_bytecode = True   # bin/__pycache__ 를 남기지 않게
import importlib.util, io, json, os, tempfile, unittest
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bf', os.path.join(HERE, '..', 'bin', 'board-feed.py'))
bf = importlib.util.module_from_spec(spec); spec.loader.exec_module(bf)

LIVE = [{'group': 'g', 'repo': 'o/r', 'liveUrl': 'https://example.invalid/version.json'}]
T = '2026-10-25T11:00:00Z'   # 머지(10:00) 뒤 노트


def issue(n, comments=(), labels=(), title=None, assignees=()):
    return {'number': n, 'title': title or f'일 {n}', 'labels': [{'name': l} for l in labels], 'body': '', 'url': f'https://github.com/o/r/issues/{n}',
            'assignees': [{'login': a} for a in assignees], 'updatedAt': '2026-10-25T00:00:00Z', 'closedAt': '2026-10-25T12:00:00Z',
            'comments': [{'body': b, 'createdAt': t} for t, b in comments]}


def pr(n, at='2026-10-25T10:00:00Z'):
    return {'number': n, 'mergedAt': at, 'mergeCommit': {'oid': 'a' * 40}}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bf.configure(dict(bf.DEFAULTS, stateDir=self.tmp.name, repos=LIVE))
        bf.DRY = False
        bf._refs.clear(); bf._unshipped.clear(); bf._kb.clear(); bf._comments.clear()
        self.refs = {106: 'OPEN'}   # #N 상태 — gh 대신
        self._old = bf.ref_state, bf.pr_state, bf.issue_state
        self._old2 = bf.compare, bf.comment_count, bf.sh
        bf.compare = lambda *a: self.fail('compare 는 시험마다 바꿔 끼움')
        bf.comment_count = lambda *a: self.fail('comment_count 는 시험마다 바꿔 끼움')
        bf.ref_state = bf.pr_state = bf.issue_state = lambda repo, n: self.refs.get(int(n), 'OPEN')

    def tearDown(self):
        bf.ref_state, bf.pr_state, bf.issue_state = self._old
        bf.compare, bf.comment_count, bf.sh = self._old2
        self.tmp.cleanup()

    def board(self, open_, merged, shipped, open_pr=None, closed=(), sheets=None, online=True, related=None, repos=LIVE):
        op = {'by': open_pr or {}, 'any': open_pr or {}, 'complete': True} if not isinstance(open_pr, dict) or 'by' not in open_pr else open_pr
        cache = {'sheets': sheets or {}, 'groups': {'g': {'open': open_, 'closed': list(closed), 'merged': merged, 'related': related or {},
                                                          'shipped': shipped, 'openpr': op}}}
        if online:   # refresh() 처럼 조회 주기에 노트가 가리키는 상태를 미리 — build 는 캐시만
            bf.prefetch(open_, 'g', 'o/r', sheets or {})
        b = bf.build(repos, cache)['cards']
        self.cards = b
        return {c['id']: c for c in b}

    def ship1(self, notes, **kw):
        lb = kw.pop('labels', ())
        return self.board([issue(1, notes, labels=lb)], {1: pr(11)}, {1: 'abc1234'}, **kw)['g#1']


class Cols(Base):
    def test_columns(self):
        b = self.board(
            [issue(1), issue(2), issue(3, labels=['계속']), issue(4), issue(5, [(T, '무엇을 기다림: hero 오베 확인')]),
             issue(6, [(T, '무엇을 기다림: #106 측정 뒤 설계')]), issue(7, [('2026-10-25T09:00:00Z', '무엇을 기다림: 없음(조사 끝)')]),
             issue(8, [('2026-10-25T09:00:00Z', '- **무엇을 기다림**: 시트 g-x-1 답')]), issue(9, labels=['doing'])],
            {1: pr(11), 2: pr(12), 3: pr(13), 4: pr(14), 5: pr(15), 6: pr(16)}, {1: 'abc1234', 3: 'abc1234', 5: 'abc1234', 6: 'abc1234'}, open_pr={2: [20]})
        st = {k: (c['status'], bool(c.get('_close'))) for k, c in b.items()}
        self.assertEqual(st['g#1'], ('ship', True))     # 실림 → 자동 닫기 후보
        self.assertEqual(st['g#2'], ('doing', False))   # 열린 PR = 하는 중
        self.assertIn('PR #20 열림', b['g#2']['note'])
        self.assertEqual(st['g#3'], ('todo', False))    # 계속 라벨
        self.assertEqual(st['g#4'], ('ship', False))    # 머지 · 배포 대기
        self.assertEqual(st['g#5'], ('ship', True))     # 머지 뒤 「확인」만 기다림 → 실림이 이김
        self.assertEqual(st['g#6'], ('wait', False))    # 머지 뒤 다른 기다림은 노트가 이김
        self.assertEqual(st['g#7'], ('todo', False))    # 없음(…) = 기다리는 것 없음
        self.assertEqual(st['g#8'], ('wait', False))    # 굵게 쓴 시트 기다림
        self.assertEqual(st['g#9'], ('doing', False))   # doing 라벨
        self.assertEqual(bf.kanban_col(b['g#8']), '기다림')
        self.assertEqual(bf.kanban_col(b['g#4']), '배포 대기')

    def test_doing_rules(self):
        bf.CFG['doingIfAssigned'] = True
        n = [(T, '무엇을 기다림: 시트 g-db-1(결정)')]
        b = self.board([issue(1, labels=['진행 중']), issue(2, assignees=['someone']), issue(3, n, labels=['doing']), issue(4, n, labels=['doing']),
                        issue(5, labels=['doing'])],
                       {5: pr(15)}, {5: 'abc1234'}, sheets={'g-db-1': '대기'})
        self.assertEqual(b['g#1']['status'], 'doing')
        self.assertEqual((b['g#2']['status'], b['g#2']['owner']), ('doing', ['someone']))
        self.assertEqual(b['g#3']['status'], 'wait')          # 안 풀린 기다림이 하는 중을 이김
        self.assertIn('시트 g-db-1 대기', b['g#3']['note'])
        self.assertEqual(b['g#5']['_block'][2], '`doing` 라벨')  # 실렸어도 하는 중이면 안 닫음
        self.assertFalse(b['g#5'].get('_close'))
        b = self.board([issue(4, n, labels=['doing'])], {}, {}, sheets={'g-db-1': '제출됨'})
        self.assertEqual(b['g#4']['status'], 'doing')          # 시트 답 옴
        bf.CFG['doingIfAssigned'] = False
        self.assertEqual(self.board([issue(2, assignees=['someone'])], {}, {})['g#2']['status'], 'todo')

    def test_no_live_site(self):   # liveUrl 없는 레포: 머지된 열린 이슈는 배포 대기(닫기 대기) — 자동 닫기 없음, 닫힌 건 끝
        b = self.board([issue(1)], {1: pr(11), 2: pr(12)}, {}, closed=[issue(2)], repos=[{'group': 'g', 'repo': 'o/r'}])
        self.assertEqual((b['g#1']['status'], b['g#1']['modeNote'], bool(b['g#1'].get('_close'))), ('ship', 'PR #11 머지 · 닫기 대기(자동 닫기 없음)', False))
        self.assertEqual(b['g#2']['status'], 'done')

    def test_no_close_when_unsure(self):
        i = issue(1); i['comments'] = None   # 댓글 못 읽음
        j = issue(2, [(T, '무엇을 기다림: hero 확인 후 2단계 진행')])
        b = self.board([i, j], {1: pr(11), 2: pr(12)}, {1: 'abc1234', 2: 'abc1234'})
        self.assertFalse(b['g#1'].get('_close'))
        self.assertEqual(b['g#1']['_block'][2], '댓글 못 읽음')
        self.assertEqual(b['g#2']['status'], 'wait')   # 확인 「후」 뒷일 = 노트가 이김
        b = self.board([issue(3)], {3: pr(13)}, {3: 'abc1234'}, open_pr=None)
        cache = {'groups': {'g': {'open': [issue(3)], 'merged': {3: pr(13)}, 'shipped': {3: 'abc1234'}, 'openpr': None}}}
        c = {x['id']: x for x in bf.build(LIVE, cache)['cards']}['g#3']   # 열린 PR 목록 못 읽음
        self.assertEqual((bool(c.get('_close')), c['_block'][2]), (False, '열린 PR 목록 못 읽음'))
        cards = [{'id': 'g#3', 'group': 'g', 'title': 't', 'status': 'ship', '_close': ('o/r', 3, 'm')}]
        bf.autoclose(cards, on=True, groups=set())   # 이번 주기에 안 읽은 그룹 → 손대지 않음
        self.assertEqual(cards[0]['status'], 'ship')

    def test_autoclose_default_off_dry_and_reopen(self):
        self.assertFalse(bf.CFG['autoclose'])   # 기본 꺼짐
        cards = [{'id': 'g#1', 'title': 't', 'status': 'ship', '_close': ('o/r', 1, 'm')},
                 {'id': 'g#2', 'title': 'u', 'status': 'todo', '_block': ('o/r', 2, '열린 PR 남음')}]
        res = bf.autoclose(cards)
        self.assertNotIn('_close', cards[0])
        self.assertNotIn('_block', cards[1])
        with open(os.path.join(self.tmp.name, 'autoclose-dry.json')) as f:
            d = json.load(f)
        self.assertEqual(d, res)
        self.assertEqual([x['issue'] for x in d['would_close']], ['o/r#1'])
        self.assertEqual(d['blocked'], [{'issue': 'o/r#2', 'title': 'u', 'reason': '열린 PR 남음'}])
        with open(os.path.join(self.tmp.name, 'autoclosed.json'), 'w') as f:
            json.dump({'o/r#1': '2026-10-25T00:00:00Z'}, f)
        cards = [{'id': 'g#1', 'title': 't', 'status': 'ship', '_close': ('o/r', 1, 'm')}]
        bf.autoclose(cards, on=True)   # 이미 닫았다가 다시 열린 이슈 — gh 안 부르고 할 일로
        self.assertEqual(cards[0]['status'], 'todo')

    def test_autoclose_cap_and_close(self):
        bf.CFG['autocloseMax'] = 2
        calls = []
        class R:
            def __init__(self, out=''):
                self.returncode, self.stdout = 0, out
        def run(a, **k):
            calls.append(a[:3])
            return R()   # timeline: 다시 연 적 없음 · close: 성공
        real = bf.subprocess.run
        bf.subprocess.run = run
        bf.comment_count = lambda repo, n: 0
        try:
            cards = [{'id': f'g#{n}', 'group': 'g', 'title': 't', 'status': 'ship', 'at': T, '_nc': 0, '_close': ('o/r', n, 'm')} for n in (1, 2, 3)]
            bf.autoclose(cards, on=True, groups={'g'})
        finally:
            bf.subprocess.run = real
        self.assertEqual([c['status'] for c in cards], ['done', 'done', 'ship'])   # 상한 2
        self.assertEqual(sum(c[:3] == ['gh', 'issue', 'close'] for c in calls), 2)
        with open(os.path.join(self.tmp.name, 'autoclosed.json')) as f:
            self.assertEqual(sorted(json.load(f)), ['o/r#1', 'o/r#2'])

    def test_dry_writes_nothing(self):
        bf.DRY = True
        bf.autoclose([{'id': 'g#1', 'title': 't', 'status': 'ship', '_close': ('o/r', 1, 'm')}], on=False)
        self.assertEqual(os.listdir(self.tmp.name), [])


class Notes(Base):
    def test_post_merge_none_note_closes(self):
        b = self.board([issue(1, [('2026-10-25T09:00:00Z', '무엇을 기다림: PR #11'),
                                  (T, '[정리] 남은 일 없음 — 배포본 실림. 닫히게 둠. 무엇을 기다림: 없음')])],
                       {1: pr(11)}, {1: 'abc1234'})
        self.assertEqual((b['g#1']['status'], bool(b['g#1'].get('_close'))), ('ship', True))

    def test_shipped_blocked_says_why(self):
        b = self.board([issue(1), issue(2, labels=['계속']), issue(3)], {1: pr(11), 2: pr(12), 3: pr(13)}, {1: 'abc1234', 2: 'abc1234', 3: 'abc1234'}, open_pr={1: [21]})
        self.assertIn('실림 — 닫기 보류', b['g#1']['note'])
        self.assertEqual(b['g#1']['_block'][2], '열린 PR 남음')
        self.assertEqual(b['g#2']['_block'][2], '`계속` 라벨')
        self.assertTrue(b['g#3'].get('_close'))
        b = self.board([issue(5)], {5: pr(15)}, {})
        self.assertEqual(b['g#5']['modeNote'], 'PR #15 머지 · 배포 대기')   # 안 실림 = 배포 대기 그대로

    def test_continue_label_configurable(self):
        bf.CFG['continueLabel'] = 'keep-open'
        self.assertEqual(self.ship1([], labels=['keep-open'])['_block'][2], '`keep-open` 라벨')
        self.assertTrue(self.ship1([], labels=['계속']).get('_close'))

    def test_ref_notes_resolve(self):
        self.refs.update({101: 'CLOSED', 102: 'MERGED', 103: 'CLOSED', 104: 'OPEN'})
        b = self.board([issue(1, [(T, '남은 일은 새 이슈 #101 로 뗌. 닫히게 둠. 무엇을 기다림: 이슈 #101')]),
                        issue(2, [(T, '무엇을 기다림: 6b 리베이스 · 재스폰(#102 머지)')]),
                        issue(3, [(T, '무엇을 기다림: 결과 시트(3.21 기준), 지금 담당 없음(#103 다음 차례).')]),
                        issue(4, [(T, '무엇을 기다림: #102 머지 — #104 머지 뒤로 미룸')]),
                        issue(5, [(T, '무엇을 기다림: 경계 뒤 재스폰. #105 머지로 해소 → #5 재개 가능(이제 안 막힘).')])],
                       {1: pr(11)}, {1: 'abc1234'})
        self.assertEqual((b['g#1']['status'], bool(b['g#1'].get('_close'))), ('ship', True))   # 풀린 머지 뒤 노트는 막지 않음
        self.assertEqual(b['g#2']['status'], 'todo')
        self.assertTrue(b['g#2']['note'].startswith('풀림'))
        self.assertEqual(b['g#3']['status'], 'todo')
        self.assertEqual(b['g#4']['status'], 'wait')   # 하나라도 남으면 기다림
        self.assertIn('#104 OPEN', b['g#4']['note'])
        self.assertEqual(b['g#5']['status'], 'todo')
        self.refs[101] = 'OPEN'
        bf._refs.clear()
        b = self.board([issue(1, [(T, '닫히게 둠. 무엇을 기다림: 이슈 #101')])], {1: pr(11)}, {1: 'abc1234'})
        self.assertEqual(b['g#1']['status'], 'wait')   # 안 풀린 머지 뒤 노트는 닫기를 막음
        self.assertEqual(b['g#1']['_block'][2], '머지 뒤 기다림 노트 안 풀림')

    def test_post_merge_resolved_with_work_is_todo(self):   # 풀렸지만 남은 일 = 할 일, 안 닫음
        self.refs.update({103: 'CLOSED', 102: 'MERGED'})
        b = self.board([issue(1, [(T, '무엇을 기다림: 경계 뒤 재스폰. #105 머지로 해소 → sim 재개 가능(이제 안 막힘).')]),
                        issue(2, [(T, '무엇을 기다림: 결과 시트, 지금 담당 없음(#103 다음 차례).')]),
                        issue(3, [(T, '[현황 정리] 담당: 없음 · 다음 행동: 매일 재고 값 확정 · 기다림: 없음')]),
                        issue(4, [(T, '무엇을 기다림: 6b 리베이스 · 재스폰(#102 머지)')]),
                        issue(5, [(T, '무엇을 기다림: 없음(상시) — 변경 쌓이면 문서 싱크')])],
                       {n: pr(10 + n) for n in range(1, 6)}, {n: 'abc1234' for n in range(1, 6)})
        for k in ('g#1', 'g#2', 'g#3', 'g#4', 'g#5'):
            self.assertEqual((b[k]['status'], bool(b[k].get('_close'))), ('todo', False), k)
            self.assertEqual(b[k]['_block'][2], '머지 뒤 노트에 남은 일')
        self.assertTrue(b['g#3']['note'].startswith('다음: 매일 재고 값 확정'))

    def test_mid_line_wait_wins(self):   # 「… · 다음 행동: … · 기다림: 없음」이 옛 노트를 덮음
        b = self.board([issue(1, [('2026-10-19T00:00:00Z', '무엇을 기다림: 상시 — 다음 시즌 끝 넘김 때 측정'),
                                  ('2026-10-20T00:00:00Z', '[현황 정리] 담당: 없음 · 다음 행동: 매일 재고 값 확정 · 기다림: 없음')])], {}, {})
        self.assertEqual(b['g#1']['status'], 'todo')
        self.assertEqual(b['g#1']['note'], '다음: 매일 재고 값 확정')

    def test_parse_kinds(self):
        for t, k in (('없음', 'none'), ('-', 'none'), ('없음(조사 완료)', 'none'), ('없음 — 단 PR #12 대기', 'pr'), ('상시', 'keep'),
                     ('이슈 #3 닫힘', 'issue'), ('시트 g-a-1', 'sheet'), ('PR #7', 'pr'), ('파일 ~/x.json', 'file'), ('hero 결정', 'human'),
                     ('2026-11-01 09:00', 'date'), ('#4 머지', 'refs'), ('owner/repo#5', 'unknown'), ('배포 v3', 'unknown')):
            self.assertEqual(bf.parse(t)[0], k, t)

    def test_none_with_remaining_work(self):
        for n in ('[정리] 1단계 머지 · 기다림: 없음 · 다음: 2단계 UI 붙이기', '무엇을 기다림: 없음. 2단계는 다음 PR 에서',
                  '무엇을 기다림: 없음 — 남은 작업: 마이그레이션 실행', '남은 작업: 마이그레이션\n무엇을 기다림: 없음'):
            c = self.ship1([(T, n)])
            self.assertFalse(c.get('_close'), n)
            self.assertEqual(c['status'], 'todo', n)
        self.assertEqual(self.ship1([(T, '무엇을 기다림: 없음 · 다음: 2단계 UI 붙이기')])['note'][:14], '다음: 2단계 UI 붙이기')
        for n in ('무엇을 기다림: 없음', '무엇을 기다림: 없음.', '무엇을 기다림: -'):
            self.assertTrue(self.ship1([(T, n)]).get('_close'), n)

    def test_confirm_whole_note_only(self):
        for n in ('확인 필요: prod 마이그레이션', '확인해서 다음 PR', 'hero 확인 — 2단계 범위 정하기', 'hero 오베 확인 — 다음 단계 정함'):
            self.assertFalse(self.ship1([(T, '무엇을 기다림: ' + n)]).get('_close'), n)
        for n in ('hero 오베 확인', 'hero 확인(이슈 열어 둠)', '배포 확인', 'hero 라이브 확인 — #33 라이브 d1fbd4b 들어감, 확인 받고 닫음'):
            self.assertTrue(self.ship1([(T, '무엇을 기다림: ' + n)]).get('_close'), n)
        self.assertFalse(self.ship1([(T, '다음 행동: 어드민 확인 2줄 · 기다림: hero 확인')]).get('_close'))   # 다음 행동이 남음

    def test_done_words_scoped(self):
        self.refs[101] = 'CLOSED'
        for n in ('닫아도 좋을지 hero 에게 물어봄. 무엇을 기다림: 이슈 #101', '1단계 남은 일 없음, 2단계 시작. 무엇을 기다림: 이슈 #101',
                  '남은 일 없음?\n무엇을 기다림: 이슈 #101', '남은 일 없음\n\n\n중간 글\n무엇을 기다림: 이슈 #101'):
            c = self.ship1([(T, n)])
            self.assertFalse(c.get('_close'), n)
            self.assertEqual(c['status'], 'todo', n)   # 풀렸지만 끝이라고 안 함 = 할 일
        self.assertTrue(self.ship1([(T, '남은 일 없음, 닫히게 둠.\n무엇을 기다림: 이슈 #101')]).get('_close'))

    def test_build_reads_cache_only(self):
        n = [0]
        bf.ref_state = bf.issue_state = lambda repo, k: (n.__setitem__(0, n[0] + 1), 'CLOSED')[1]
        c = self.ship1([(T, '닫히게 둠. 무엇을 기다림: 이슈 #101')], online=False)   # 조회 주기 밖 — gh 안 부름
        self.assertEqual((n[0], c['status'], bool(c.get('_close'))), (0, 'wait', False))
        self.assertIn('확인 차례', c['note'])
        c = self.ship1([(T, '닫히게 둠. 무엇을 기다림: 이슈 #101')])                  # prefetch 뒤엔 캐시로 닫힘
        self.assertEqual((n[0], bool(c.get('_close'))), (1, True))
        self.ship1([(T, '닫히게 둠. 무엇을 기다림: 이슈 #101')])
        self.assertEqual(n[0], 1)   # 같은 번호는 한 주기에 한 번


class Prs(Base):
    def test_close_grade_refs(self):
        t = lambda title: bf.close_refs({'title': title})
        for x in ('a (#301 조사용)', 'a (#301 follow-up)', 'a (#301 관련 리팩터)', 'a (#301 되돌림)', 'a (#301 후속)', 'see #301'):
            self.assertEqual(t(x), set(), x)
        for x in ('a (#301)', 'a (Refs #301)', 'a (#301 ②③)', 'a (#301 1/3)', 'a (#301 7·8)', 'a (#301 6a)', 'a (#301 6)'):
            self.assertEqual(t(x), {301}, x)
        b = self.board([issue(1)], {}, {}, closed=[issue(2)], related={1: pr(11), 2: pr(12)})
        self.assertEqual((b['g#1']['status'], b['g#1']['note']), ('todo', '관련 PR #11 머지(닫기 근거 아님)'))   # 보기만
        self.assertEqual(b['g#2']['status'], 'done')   # 닫힌 이슈도 보기용 PR 로는 배포 대기 안 함

    def test_merged_cache_keeps_old(self):   # 최근 100개 밖 오래된 머지도 남음
        calls, old_sh = [], bf.sh
        cir = lambda n, repo='r': [{'number': n, 'repository': {'name': repo, 'owner': {'login': 'o'}}}]
        def fake(*a, **k):
            calls.append(a[a.index('--limit') + 1])
            if a[a.index('--limit') + 1] == '3000':
                return json.dumps([{'number': 203, 'title': 'x (#202)', 'mergedAt': '2026-10-11T09:06:12Z', 'mergeCommit': {'oid': 'b' * 40}},
                                   {'number': 204, 'title': 'y (#202 ②③)', 'mergedAt': '2026-10-11T06:51:09Z', 'mergeCommit': {'oid': 'c' * 40}},
                                   {'number': 302, 'title': 'z (#301 후속)', 'mergedAt': '2026-10-11T07:00:00Z', 'mergeCommit': {'oid': 'd' * 40}},
                                   {'number': 303, 'title': 'w', 'closingIssuesReferences': cir(77) + cir(78, 'other'), 'mergedAt': '2026-10-11T07:00:00Z', 'mergeCommit': {'oid': 'f' * 40}}])
            return json.dumps([{'number': 304, 'title': 'docs (#101)', 'mergedAt': '2026-10-25T12:26:00Z', 'mergeCommit': {'oid': 'e' * 40}}])
        bf.sh = fake
        try:
            m1, r1 = bf.merged_prs('o/r')
            m2, r2 = bf.merged_prs('o/r')
        finally:
            bf.sh = old_sh
        self.assertEqual(calls, ['3000', '100'])   # 처음 한 번 전부, 그다음 최근만
        self.assertEqual(m1[202]['number'], 203)
        self.assertNotIn(301, m1)                   # '(#301 후속)' 은 닫기 근거 아님 — 보기용만
        self.assertEqual(r1[301]['number'], 302)
        self.assertEqual(m1[77]['number'], 303)    # Closes 연결(closingIssuesReferences)
        self.assertNotIn(78, m1)                     # 다른 레포 이슈
        self.assertEqual((m2[202]['number'], m2[101]['number']), (203, 304))

    def test_side_branch_merge_not_shipped(self):   # 에픽 base 로 머지된 PR 은 닫기 근거 아님, mainBranches 로 바꿈
        old_sh = bf.sh
        bf.sh = lambda *a, **k: json.dumps([{'number': 63, 'title': 'S1 (#54)', 'baseRefName': 'feature/base', 'mergedAt': '2026-07-25T10:12:39Z', 'mergeCommit': {'oid': 'a' * 40}},
                                            {'number': 70, 'title': 'x (#60)', 'baseRefName': 'main', 'mergedAt': '2026-07-26T10:00:00Z', 'mergeCommit': {'oid': 'b' * 40}},
                                            {'number': 71, 'title': 'y (#61)', 'baseRefName': 'develop', 'mergedAt': '2026-07-26T10:00:00Z', 'mergeCommit': {'oid': 'c' * 40}}])
        try:
            m, r = bf.merged_prs('o/r')
            self.assertNotIn(54, m)
            self.assertEqual(r[54]['number'], 63)
            self.assertEqual(m[60]['number'], 70)
            self.assertNotIn(61, m)
            bf.CFG['mainBranches'] = ['main', 'develop']
            m, r = bf.merged_prs('o/r')
            self.assertEqual(m[61]['number'], 71)
        finally:
            bf.sh = old_sh

    def test_full_refetch_backoff(self):
        calls, old_sh = [], bf.sh
        def fake(*a, **k):
            calls.append(a[a.index('--limit') + 1])
            return '' if a[a.index('--limit') + 1] == '3000' else '[]'
        bf.sh = fake
        try:
            bf.merged_prs('o/r'); bf.merged_prs('o/r'); bf.merged_prs('o/r')
        finally:
            bf.sh = old_sh
        self.assertEqual(calls, ['3000', '100', '100'])   # 실패한 전부 읽기는 MERGED_FULL_RETRY 동안 다시 안 함

    def test_closed_not_shipped(self):   # 닫혔어도 안 실렸으면 배포 대기
        cl = [issue(1), issue(2), issue(3)]
        b = self.board([], {1: pr(11), 2: pr(12)}, {2: 'abc1234'}, closed=cl)
        self.assertEqual(b['g#1']['status'], 'ship')
        self.assertEqual(b['g#1']['modeNote'], '닫힘 — PR #11 배포 대기')
        self.assertEqual(b['g#2']['status'], 'done')
        self.assertEqual(b['g#3']['status'], 'done')   # 머지 PR 없음
        b = self.board([], {1: pr(11)}, None, closed=cl)   # 배포본 커밋 못 읽음 → 그냥 끝
        self.assertEqual(b['g#1']['status'], 'done')

    def test_unshipped_rechecked_only_on_new_live(self):
        calls, old_live = [], bf.live_sha
        live = ['1' * 40]
        bf.live_sha = lambda url: live[0]
        bf.compare = lambda *a: (calls.append(a), 'behind')[1]
        try:
            m = {1: pr(11)}
            self.assertEqual(bf.shipped('o/r', 'https://x/version.json', m, {1}), {})
            bf.shipped('o/r', 'https://x/version.json', m, {1})
            self.assertEqual(len(calls), 1)
            live[0] = '2' * 40
            bf.shipped('o/r', 'https://x/version.json', m, {1})
            self.assertEqual(len(calls), 2)
            bf.compare = lambda *a: 'ahead'
            self.assertEqual(bf.shipped('o/r', 'https://x/version.json', {2: dict(pr(12), mergeCommit={'oid': 'b' * 40})}, {2}), {2: '2222222'})
            self.assertEqual(bf.shipped('o/r', None, m, {1}), {})   # liveUrl 없음
        finally:
            bf.live_sha = old_live

    def test_corrupt_caches(self):
        for name, junk in (('merged.json', {'o/r': {'prs': {'1': 'x', 'y': {}, '2': {'refs': 'bad', 'mergedAt': 5}}, 'full': 'z'}}),
                           ('shipped.json', {'a' * 40: ['x']})):
            with open(os.path.join(self.tmp.name, name), 'w') as f:
                json.dump(junk, f)
        old_sh, old_live = bf.sh, bf.live_sha
        bf.sh, bf.live_sha, bf.compare = (lambda *a, **k: 'null'), (lambda url: '1' * 40), (lambda *a: None)
        try:
            self.assertEqual(bf.merged_prs('o/r'), ({}, {}))
            self.assertEqual(bf.shipped('o/r', 'https://x/version.json', {1: pr(11)}, {1}), {})
        finally:
            bf.sh, bf.live_sha = old_sh, old_live

    def test_issue_list_failure(self):
        old = bf.sh
        bf.sh = lambda *a, **k: ''
        try:
            self.assertEqual(bf.issues('o/r'), (None, None))
        finally:
            bf.sh = old


class Loop(Base):
    def test_reopen_then_finished_note_closes(self):   # 다시 연 뒤 「남은 일 없음」 노트면 닫아도 됨
        class R:
            returncode, stdout = 0, '2026-10-25T05:18:30Z\n'
        real = bf.subprocess.run
        bf.subprocess.run = lambda *a, **k: R()
        try:
            self.assertTrue(bf.reopened_after('o/r', 1, '2026-10-24T10:00:00Z'))
            self.assertTrue(bf.reopened_after('o/r', 1, '2026-10-24T10:00:00Z', '2026-10-25T05:00:00Z'))   # 노트가 다시 열기보다 먼저
            self.assertFalse(bf.reopened_after('o/r', 1, '2026-10-24T10:00:00Z', '2026-10-25T11:58:00Z'))
        finally:
            bf.subprocess.run = real

    def test_finished_card_carries_note_time(self):
        c = self.ship1([(T, '남은 일 없음, 닫히게 둠.\n무엇을 기다림: 없음')])
        self.assertEqual(c['_fin'], T)
        cards = [c]
        bf.autoclose(cards, on=False)
        self.assertNotIn('_fin', cards[0])

    def test_stale_comments_fallback(self):   # 댓글 조회만 실패 → 지난 댓글로 판정, 그 그룹은 닫기 안 함
        rounds = [[issue(1, [(T, '무엇을 기다림: 시트 g-a-1')])], [issue(1)]]
        old = (bf.issues, bf.merged_prs, bf.open_prs, bf.shipped, bf.sheet_states)
        def fake_issues(repo):
            o = rounds.pop(0)
            if not rounds:
                o[0]['comments'] = None
            return o, []
        bf.issues, bf.merged_prs, bf.open_prs = fake_issues, (lambda repo: ({1: pr(11)}, {})), (lambda repo: {'by': {}, 'any': {}, 'complete': True})
        bf.shipped, bf.sheet_states = (lambda *a: {1: 'abc1234'}), (lambda: {'g-a-1': '대기'})
        try:
            cache = {}
            self.assertEqual(bf.refresh(LIVE, cache), ({'g'}, set()))
            self.assertEqual(bf.refresh(LIVE, cache), (set(), {'g'}))
            c = {x['id']: x for x in bf.build(LIVE, cache)['cards']}['g#1']
            self.assertEqual(c['status'], 'wait')   # 지난 댓글의 노트가 살아 있음
            bf.issues = lambda repo: (None, None)   # 이슈 목록부터 실패 → 지난 판정 유지, 새로 읽은 그룹 아님
            self.assertEqual(bf.refresh(LIVE, cache), (set(), set()))
            self.assertEqual(cache['groups']['g']['open'][0]['number'], 1)
        finally:
            bf.issues, bf.merged_prs, bf.open_prs, bf.shipped, bf.sheet_states = old

    def test_skip(self):   # 진짜 에픽·로드맵 묶음만 뺀다
        sk = lambda t, *l: bf.skip({'title': t, 'labels': [{'name': x} for x in l]})
        for t in ('[x] 에픽 — 밸런스', '[x] 에픽: 알림', '[x] [Epic] 규칙 v2', 'Epic: 무엇', '[x] 로드맵 — 전체'):
            self.assertTrue(sk(t), t)
        self.assertTrue(sk('[Sub] 무엇', 'epic'))
        for t, l in (('[epic-flow] 컨텍스트 관리', ()), ('epic-flow: 덤프', ()), ('[Sub] S10', ('sub', 'epic:v3')), ('로드맵 1 등록', ('P1',))):
            self.assertFalse(sk(t, *l), t)

    def test_config(self):
        p = os.path.join(self.tmp.name, 'c.json')
        with open(p, 'w') as f:
            json.dump({'repos': [{'group': 'a', 'repo': 'o/a', 'liveUrl': 'https://x/version.json', 'kanban': True}], 'autoclose': True}, f)
        c = bf.load_config(p, env={})
        self.assertEqual((c['repos'][0]['repo'], c['autoclose'], c['autocloseMax'], c['continueLabel']), ('o/a', True, 5, '계속'))
        c = bf.load_config(p, env={'BOARD_AUTOCLOSE': 'off', 'BOARD_REPOS': 'b=o/b c=o/c@https://y/version.json', 'BOARD_MAIN_BRANCHES': 'main,trunk'})
        self.assertEqual((c['autoclose'], [r['repo'] for r in c['repos']], c['repos'][1]['liveUrl'], c['mainBranches']),
                         (False, ['o/b', 'o/c'], 'https://y/version.json', ['main', 'trunk']))
        self.assertFalse(bf.load_config(None, env={})['autoclose'])
        with self.assertRaises(ValueError):
            bf.load_config(None, env={'BOARD_REPOS': 'x=not-a-repo'})


class Review2(Base):
    """독립 리뷰 지적 — 고친 동작마다 하나씩."""
    def test_1_config_strict_types(self):
        p = os.path.join(self.tmp.name, 'c.json')
        for bad in ({'autoclose': 'false'}, {'autoclose': 1}, {'autocloseMax': '5'}, {'doneHours': 4.5}, {'interval': 0},
                    {'mainBranches': 'main'}, {'doingLabels': ['ok', 3]}, {'skipLabels': None}, {'doingIfAssigned': 'yes'},
                    {'repos': [{'group': 'a', 'repo': 'o/a', 'kanban': 'true'}]}, {'repos': [{'group': 'a', 'repo': 'o/a', 'liveUrl': 'ftp://x'}]}):
            with open(p, 'w') as f:
                json.dump(dict({'repos': [{'group': 'a', 'repo': 'o/a'}]}, **bad), f)
            with self.assertRaises(ValueError, msg=bad):
                bf.load_config(p, env={})
        for env in ({'BOARD_AUTOCLOSE': 'yes'}, {'BOARD_CLOSE_MAX': 'abc'}, {'BOARD_DONE_HOURS': '-1'}, {'BOARD_INTERVAL': '0'}):
            with self.assertRaises(ValueError, msg=env):
                bf.load_config(None, env=dict(env, BOARD_REPOS='a=o/a'))
        with open(p, 'w') as f:
            json.dump({'repos': [{'group': 'a', 'repo': 'o/a'}], 'autoclose': 'true'}, f)
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(bf.main(['--config', p, '--dry']), 2)   # 틀린 형식 → stderr + exit 2
        self.assertIn('autoclose', err.getvalue())
        self.assertFalse(bf.autoclose([], on='true')['on'])          # 진짜 True 일 때만 켜짐

    def fake_issue_list(self, comments_by_no):
        def sh(*a, **k):
            if 'number,comments' in a:
                return json.dumps([{'number': n, 'comments': cs} for n, cs in comments_by_no.items()])
            if '--state' in a and a[a.index('--state') + 1] == 'open':
                return json.dumps([dict(issue(n), comments=None) for n in (1, 2, 3)])
            return '[]'
        return sh

    def test_2_4_comment_limit_and_missing(self):
        many = [{'body': f'c{k}', 'createdAt': T} for k in range(100)]
        full = many + [{'body': '무엇을 기다림: PR #9', 'createdAt': T}]   # 101번째에 노트
        bf.sh = self.fake_issue_list({1: many, 2: [{'body': '무엇을 기다림: 없음', 'createdAt': T}], 4: many})   # 3 은 댓글 목록에 없음
        bf.sh = (lambda inner: lambda *a, **k: json.dumps([dict(issue(n), comments=None) for n in (1, 2, 3, 4)])
                 if '--state' in a and a[a.index('--state') + 1] == 'open' and 'number,comments' not in a else inner(*a, **k))(bf.sh)
        bf.comment_count = lambda repo, n: 101
        pages = []
        class R:
            def __init__(self, rc, out):
                self.returncode, self.stdout = rc, out
        def run(a, **k):   # 1 = 전부 읽힘, 4 = 페이지 넘김 실패
            pages.append(a)
            n = int(a[3].split('/')[4])
            return R(0, '\n'.join(json.dumps(c, ensure_ascii=False) for c in full)) if n == 1 else R(1, '')
        real = bf.subprocess.run
        bf.subprocess.run = run
        try:
            o, c = bf.issues('o/r')
            bf.issues('o/r')                                     # 같은 댓글 수 = 캐시, 다시 안 읽음
        finally:
            bf.subprocess.run = real
        self.assertEqual(sum('repos/o/r/issues/1/comments?per_page=100' in a for a in pages), 1)
        by = {i['number']: i for i in o}
        self.assertEqual(len(by[1]['comments']), 101)            # 100개 넘어도 전부 — 노트를 제대로 읽음
        self.assertIsNone(by[4]['comments'])
        self.assertIn('전부 못 읽음', by[4]['_unread'])
        self.assertEqual(len(by[2]['comments']), 1)
        self.assertIsNone(by[3]['comments'])                      # [] 가 아니라 None — 못 읽음
        self.assertEqual(by[3]['_unread'], '댓글 목록에 없음')
        self.refs[9] = 'OPEN'
        b = self.board(o, {n: pr(10 + n) for n in (1, 2, 3, 4)}, {n: 'abc1234' for n in (1, 2, 3, 4)})
        self.assertEqual((b['g#1']['status'], b['g#1']['_block'][2]), ('wait', '머지 뒤 기다림 노트 안 풀림'))
        self.assertEqual((bool(b['g#4'].get('_close')), b['g#4']['_block'][2]), (False, by[4]['_unread']))
        self.assertEqual((bool(b['g#3'].get('_close')), b['g#3']['_block'][2]), (False, '댓글 목록에 없음'))
        self.assertTrue(b['g#2'].get('_close'))
        self.assertEqual(b['g#2']['_nc'], 1)
        res = bf.autoclose(self.cards, on=False)
        self.assertEqual({x['issue'] for x in res['blocked']}, {'o/r#1', 'o/r#3', 'o/r#4'})
        bf.comment_count = lambda repo, n: 102                   # 수가 늘었는데 읽은 건 101 → 모자람 = 못 읽음
        bf.subprocess.run = run
        try:
            self.assertIsNone(bf.all_comments('o/r', 1))
        finally:
            bf.subprocess.run = real
        bf.comment_count = lambda repo, n: 101                   # 지우고 하나 더함 — 수는 같고 updatedAt 만 바뀜 → 다시 읽음
        pages.clear()
        bf.subprocess.run = run
        try:
            self.assertEqual(len(bf.all_comments('o/r', 1, '2026-10-25T00:00:00Z')), 101)   # issues() 가 쓴 키 — 캐시
            self.assertEqual(len(pages), 0)
            self.assertEqual(len(bf.all_comments('o/r', 1, '2026-10-26T00:00:00Z')), 101)
            self.assertEqual(len(pages), 1)
        finally:
            bf.subprocess.run = real
        # 이슈 하나만 못 읽은 건 그룹 전체 stale 이 아님
        old = (bf.issues, bf.merged_prs, bf.open_prs, bf.shipped, bf.sheet_states)
        bf.issues, bf.merged_prs, bf.open_prs = (lambda repo: (o, [])), (lambda repo: ({}, {})), (lambda repo: {'by': {}, 'any': {}, 'complete': True})
        bf.shipped, bf.sheet_states = (lambda *a: {}), (lambda: {})
        try:
            self.assertEqual(bf.refresh(LIVE, {}), ({'g'}, set()))
        finally:
            bf.issues, bf.merged_prs, bf.open_prs, bf.shipped, bf.sheet_states = old

    def test_2_comment_count_verified_before_close(self):
        class R:
            returncode, stdout = 0, ''
        real = bf.subprocess.run
        bf.subprocess.run = lambda *a, **k: R()
        try:
            bf.comment_count = lambda repo, n: 2   # 읽은 뒤 새 댓글이 붙음
            cards = [{'id': 'g#1', 'group': 'g', 'title': 't', 'status': 'ship', 'at': T, '_nc': 1, '_close': ('o/r', 1, 'm')}]
            res = bf.autoclose(cards, on=True, groups={'g'})
            self.assertEqual(cards[0]['status'], 'ship')
            self.assertIn('댓글 수가 다름', res['blocked'][0]['reason'])
            bf.comment_count = lambda repo, n: None
            cards = [{'id': 'g#1', 'group': 'g', 'title': 't', 'status': 'ship', 'at': T, '_nc': 1, '_close': ('o/r', 1, 'm')}]
            bf.autoclose(cards, on=True, groups={'g'})
            self.assertEqual(cards[0]['status'], 'ship')
        finally:
            bf.subprocess.run = real

    def test_3_open_pr_guard_wide(self):
        cir = lambda n, repo='r': [{'number': n, 'repository': {'name': repo, 'owner': {'login': 'o'}}}]
        p = {'number': 9, 'title': 'tidy #12', 'body': 'see #13, other/x#14, o/r#15', 'headRefName': 'fix/x-16-v2', 'closingIssuesReferences': cir(17) + cir(18, 'z')}
        self.assertEqual(bf.mention_refs(p, 'o/r'), {2, 12, 13, 15, 16, 17})   # v2 의 2 도 — 막기는 넓게
        self.assertEqual(bf.mention_refs({'headRefName': 'fix-issue12'}, 'o/r'), {12})   # 앞 글자 허용 — 막기는 넓게
        self.assertEqual(bf.mention_refs({'body': 'https://github.com/O/R/issues/21 · github.com/o/r/pull/22 · github.com/o/other/issues/23 · GH-24 · xGH-25'}, 'o/r'),
                         {21, 22, 24})
        bf.sh = lambda *a, **k: json.dumps([p])
        op = bf.open_prs('o/r')
        self.assertEqual((op['complete'], op['by'].get(17), op['any'].get(16)), (True, [9], [9]))   # Closes 연결 = 하는 중 근거
        self.assertFalse({12, 13, 16} & set(op['by']))        # 본문에 지나가듯 쓴 #13 은 하는 중 근거가 아님 — 닫기만 막음
        b = self.board([issue(13), issue(16)], {13: pr(23), 16: pr(26)}, {13: 'abc1234', 16: 'abc1234'}, open_pr=op)
        for k in ('g#13', 'g#16'):
            self.assertEqual((b[k]['status'], bool(b[k].get('_close')), b[k]['_block'][2]), ('ship', False, '열린 PR #9 이 가리킴'), k)
        bf.sh = lambda *a, **k: json.dumps([{'number': n, 'title': 'x'} for n in range(bf.OPEN_PR_LIMIT)])
        op = bf.open_prs('o/r')
        self.assertFalse(op['complete'])        # 상한만큼 옴 = 다 못 읽음 → 그 레포는 안 닫음
        b = self.board([issue(1)], {1: pr(11)}, {1: 'abc1234'}, open_pr=op)
        self.assertEqual((bool(b['g#1'].get('_close')), b['g#1']['_block'][2]), (False, f'열린 PR 이 {bf.OPEN_PR_LIMIT}개 이상(다 못 읽음)'))

    def test_5_shipped_rechecked_on_live_change(self):   # 되돌림 배포 — 실렸던 머지도 새 배포본 커밋으로 다시 본다
        live, st, calls = ['1' * 40], ['ahead'], []
        old_live = bf.live_sha
        bf.live_sha = lambda url: live[0]
        bf.compare = lambda *a: (calls.append(a), st[0])[1]
        try:
            m = {1: pr(11)}
            self.assertEqual(bf.shipped('o/r', 'https://x/v.json', m, {1}), {1: '1111111'})
            self.assertEqual(bf.shipped('o/r', 'https://x/v.json', m, {1}), {1: '1111111'})
            self.assertEqual(len(calls), 1)                      # 같은 배포본 = 캐시
            with open(os.path.join(self.tmp.name, 'shipped.json')) as f:
                self.assertEqual(json.load(f), {'a' * 40: '1' * 40})   # 캐시에 배포본 커밋을 같이
            live[0], st[0] = '0' * 40, 'behind'                  # 옛 커밋으로 되돌림
            self.assertEqual(bf.shipped('o/r', 'https://x/v.json', m, {1}), {})
            self.assertEqual(len(calls), 2)
        finally:
            bf.live_sha = old_live

    def test_6_compare_error_not_cached(self):
        class R:
            def __init__(self, rc, out):
                self.returncode, self.stdout = rc, out
        real = bf.subprocess.run
        bf.compare = self._old2[0]
        try:
            bf.subprocess.run = lambda *a, **k: R(1, 'ahead')    # 오류 코드면 출력이 있어도 실패
            self.assertIsNone(bf.compare('o/r', 'a', 'b'))
            bf.subprocess.run = lambda *a, **k: R(0, 'ahead\n')
            self.assertEqual(bf.compare('o/r', 'a', 'b'), 'ahead')
        finally:
            bf.subprocess.run = real
        calls, old_live = [], bf.live_sha
        bf.live_sha = lambda url: '1' * 40
        bf.compare = lambda *a: (calls.append(a), None)[1]
        try:
            self.assertEqual(bf.shipped('o/r', 'https://x/v.json', {1: pr(11)}, {1}), {})
            self.assertEqual(bf._unshipped, {})                  # 안 실림으로 기억하지 않음
            bf.shipped('o/r', 'https://x/v.json', {1: pr(11)}, {1})
            self.assertEqual(len(calls), 2)                      # 다음 주기에 다시 비교
        finally:
            bf.live_sha = old_live

    def test_8_loop_survives_tick_error(self):
        p = os.path.join(self.tmp.name, 'c.json')
        with open(p, 'w') as f:
            json.dump({'repos': [{'group': 'a', 'repo': 'o/a'}], 'stateDir': self.tmp.name}, f)
        class Stop(BaseException):
            pass
        n = [0]
        def tick(cache):
            n[0] += 1
            if n[0] == 1:
                raise RuntimeError('gh 가 이상함')
            raise Stop()
        old = bf.tick, bf.time.sleep
        bf.tick, bf.time.sleep = tick, (lambda s: None)
        err = io.StringIO()
        try:
            with redirect_stderr(err), self.assertRaises(Stop):
                bf.main(['--config', p])
            n[0] = 0
            with redirect_stderr(err):
                self.assertEqual(bf.main(['--config', p, '--once']), 1)
        finally:
            bf.tick, bf.time.sleep = old
        self.assertIn('주기 실패 — RuntimeError', err.getvalue())

    def test_9_kanban_leaves_foreign_project(self):
        calls = []
        def sh(*a, **k):
            calls.append(a[:3])
            if a[1:3] == ('project', 'list'):
                return json.dumps({'projects': [{'id': 'PVT_x', 'number': 3, 'title': 'g 칸반'}]})
            if a[1:3] == ('project', 'field-list'):
                return json.dumps({'fields': [{'id': 'F1', 'name': 'Status', 'options': [{'id': 'o1', 'name': 'Todo'}]}]})
            return '{}'
        bf.sh = sh
        with redirect_stderr(io.StringIO()):
            self.assertIsNone(bf.kanban_setup('g', 'o/r'))          # 남이 만든 프로젝트 — 열을 안 바꿈
        self.assertNotIn(('gh', 'api', 'graphql'), calls)
        with open(os.path.join(self.tmp.name, 'kanban.json'), 'w') as f:
            json.dump({'created': ['PVT_x']}, f)
        calls.clear()
        bf.kanban_setup('g', 'o/r')                                 # 이 스크립트가 만든 것만 열을 칸반 열로
        self.assertIn(('gh', 'api', 'graphql'), calls)


if __name__ == '__main__':
    unittest.main()
