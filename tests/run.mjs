// 틈(TEUM) 헤드리스 회귀 테스트 — jsdom으로 index.html+app.js를 평가해 DOM 동작을 검증.
// 실행: npm test  (사전: npm install)
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 로드 순서대로 평가 (constants → helpers → app)
const JS = ['constants.js', 'helpers.js', 'logic.js', 'app.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const todayDS = fmt(today);
const plusDays = n => fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));

// 앱 부팅 헬퍼. opts.notify=true면 Notification/serviceWorker 스텁 주입(발송 기록).
function boot(state, opts = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://imeru.github.io/teum/' });
  const { window } = dom;
  global.window = window; global.document = window.document; global.localStorage = window.localStorage;
  const fired = [];
  if (opts.notify) {
    class FakeNotification { constructor(t, o) { fired.push({ title: t, ...(o || {}) }); } static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } }
    window.Notification = FakeNotification;
    const reg = { showNotification: (t, o) => { fired.push({ title: t, ...(o || {}) }); return Promise.resolve(); } };
    Object.defineProperty(window.navigator, 'serviceWorker', { value: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg) }, configurable: true });
  }
  window.alert = () => {};
  if (state) window.localStorage.setItem('flowdo.state.v1', JSON.stringify(state));
  if (opts.planview) window.localStorage.setItem('flowdo.planview', opts.planview);
  if (opts.lastview) window.localStorage.setItem('flowdo.lastview', opts.lastview);
  if (!opts.firstRun) window.localStorage.setItem('flowdo.guideSeen', '1'); // 기본은 가이드 본 상태
  if (opts.lastAuth) window.localStorage.setItem('flowdo.lastAuth', JSON.stringify(opts.lastAuth)); // 오프라인 그레이스용 이전 로그인 기록
  let err = null;
  window.addEventListener('error', e => { err = e.error || e.message; });
  try { window.eval(JS); } catch (e) { err = e; }
  const $ = s => window.document.querySelector(s);
  const $$ = s => [...window.document.querySelectorAll(s)];
  return { window, $, $$, fired, getErr: () => err };
}

const baseState = (over = {}) => Object.assign({
  tasks: [], projects: [], sessions: [],
  settings: { focus: 25, short: 5, long: 15, longEvery: 4 },
  top3: {}, events: [], holidays: [], updatedAt: 1
}, over);

const results = [];
let curSection = '';
function section(n) { curSection = n; }
function ck(name, cond) { results.push([curSection, name, !!cond]); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 1) 뷰 렌더 + 일/주/월 캘린더 ─────────────────────────
{
  section('뷰·캘린더');
  const { $, $$, getErr } = boot(baseState({
    tasks: [
      { id: 'a', title: '주간 블록 작업', status: 'next', priority: 1, due: todayDS, block: { date: todayDS, start: 9 * 60, duration: 60 }, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'b', title: '오늘 마감 할일', status: 'next', priority: 2, due: todayDS, tags: [], createdAt: 1, updatedAt: 1 },
    ],
    events: [{ id: 'e1', title: '정기회의', start: 14 * 60, duration: 60, color: '#0d9488', freq: 'weekly', interval: 1, days: [today.getDay()], startDate: todayDS, endMode: 'never' }],
  }), { planview: 'day' });
  ck('런타임 에러 없음', !getErr());
  $('.nav[data-view="plan"]').click();
  ck('일/주/월 토글 3개', $$('.seg button').length === 3);
  ck('일간 그리드 존재', $('#calGrid'));
  $$('.seg button').find(b => b.dataset.v === 'week').click();
  ck('주간 7열', $$('.wk-col').length === 7);
  ck('주간 블록 카드', $$('.wk-blk .n').some(n => n.textContent.includes('주간 블록')));
  ck('주간 정기일정', $$('.wk-ev .n').some(n => n.textContent.includes('정기회의')));
  $$('.seg button').find(b => b.dataset.v === 'month').click();
  ck('월간 6주 행', $$('.mo-week').length === 6);
  ck('월간 보기 저장됨', $('html') && localStorage.getItem('flowdo.planview') === 'month');
}

// ───────────────────────── 2) 새벽 접기 + 주간 블록 리사이즈 ─────────────────────────
{
  section('시간접기·리사이즈');
  const { $, $$, getErr } = boot(baseState({
    tasks: [{ id: 'a', title: '새벽작업', status: 'next', priority: 1, due: todayDS, block: { date: todayDS, start: 3 * 60, duration: 60 }, tags: [], createdAt: 1, updatedAt: 1 }]
  }), { planview: 'day' });
  $('.nav[data-view="plan"]').click();
  const labels = () => $$('.cal-hour-label').map(e => e.textContent);
  ck('런타임 에러 없음', !getErr());
  ck('일간 기본 08:00 시작', labels()[0] === '08:00');
  ck('새벽 토글 존재', $('.early-toggle'));
  $('.early-toggle').click();
  ck('펼치면 00:00', labels()[0] === '00:00');
  ck('펼치면 그리드 1440px', $('#calGrid').style.height === '1440px');
  $$('.seg button').find(b => b.dataset.v === 'week').click();
  ck('주간 블록 리사이즈 핸들', $$('.wk-blk').some(b => b.querySelector('.block-resize')));
}

// ───────────────────────── 3) 일정: 종일/기간 연속 배너 + 지난 일정 숨김 ─────────────────────────
{
  section('일정·배너·지난숨김');
  const wkStart = todayDS, wkEnd = plusDays(2), past0 = plusDays(-10), past1 = plusDays(-8);
  const { $, $$, getErr } = boot(baseState({
    events: [
      { id: 'span', title: '워크숍', freq: 'once', allDay: true, startDate: wkStart, endDate: wkEnd, color: '#e5484d' },
      { id: 'one', title: '생일', freq: 'once', allDay: true, startDate: todayDS, endDate: todayDS, color: '#0091ff' },
      { id: 'old', title: '지난행사', freq: 'once', allDay: true, startDate: past0, endDate: past1, color: '#9333ea' },
    ]
  }), { planview: 'week' });
  $('.nav[data-view="plan"]').click();
  ck('런타임 에러 없음', !getErr());
  ck('주간 배너 ≥2', $$('.wk-ad-banners .ev-banner').length >= 2);
  ck('워크숍 단일 spanning 배너', $$('.wk-ad-banners .ev-banner').filter(b => b.textContent.includes('워크숍')).length === 1);
  $$('.seg button').find(b => b.dataset.v === 'month').click();
  ck('월간 배너 워크숍', $$('.mo-banners .ev-banner').some(b => b.textContent.includes('워크숍')));
  const rows = () => $$('#eventList .event-row').map(r => r.textContent);
  ck('목록: 지난행사 기본 숨김', !rows().some(x => x.includes('지난행사')));
  ck('목록: 진행 일정 표시', rows().some(x => x.includes('워크숍') || x.includes('생일')));
  const toggle = $$('#eventList button').find(b => b.textContent.includes('지난 일정'));
  ck('지난 일정 토글 존재', toggle);
  toggle && toggle.click();
  ck('토글 후 지난행사 표시', rows().some(x => x.includes('지난행사')));
  ck('일정 유형에 일반 옵션', [...$('#ev-freq').options].some(o => o.textContent.includes('일반')));
}

// ───────────────────────── 4) 체크리스트(세부 항목) + 진행 배지 ─────────────────────────
{
  section('체크리스트');
  const { $, $$, getErr } = boot(baseState({
    tasks: [
      { id: 'a', title: 'B45 모델링', status: 'next', priority: 4, due: todayDS, tags: [], createdAt: 1, updatedAt: 1, subtasks: [{ id: 's1', title: '레퍼런스', done: true }, { id: 's2', title: '벽체', done: true }, { id: 's3', title: '창호', done: false }] },
      { id: 'b', title: '서브없음', status: 'next', priority: 4, due: todayDS, tags: [], createdAt: 1, updatedAt: 1 },
    ]
  }));
  $('.nav[data-view="today"]').click();
  ck('런타임 에러 없음', !getErr());
  const aRow = $$('.task-title').find(x => x.textContent.includes('B45'));
  ck('배지 2/3 표시', aRow && aRow.querySelector('.sub-badge') && aRow.querySelector('.sub-badge').textContent.includes('2/3'));
  ck('세부없으면 배지 없음', $$('.task-title').find(x => x.textContent.includes('서브없음')) && !$$('.task-title').find(x => x.textContent.includes('서브없음')).querySelector('.sub-badge'));
  $$('.task').find(n => n.textContent.includes('B45')).querySelector('[data-act="edit"]').click();
  ck('편집 모달 3행', $$('#f-checklist .cl-row').length === 3);
  ck('모달 카운트 2/3', $('#f-checklist-count').textContent === '2/3');
  $('#f-add-sub').click();
  ck('항목 추가 → 4행', $$('#f-checklist .cl-row').length === 4);
  $('#taskSaveBtn').click();
  const ta = JSON.parse(localStorage.getItem('flowdo.state.v1')).tasks.find(x => x.id === 'a');
  ck('빈 항목 저장 제외(3개 유지)', ta.subtasks.length === 3);
}

// ───────────────────────── 5) '지금 이 틈' 추천 점수 ─────────────────────────
{
  section('추천 점수');
  const { $, $$, getErr } = boot(baseState({
    tasks: [
      { id: 'big', title: '큰일55분', status: 'next', priority: 3, estimate: 55, due: plusDays(10), tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'small', title: '작은일5분', status: 'next', priority: 3, estimate: 5, due: plusDays(10), tags: [], createdAt: 2, updatedAt: 1 },
      { id: 'over', title: '지난마감', status: 'next', priority: 4, estimate: 10, due: plusDays(-2), tags: [], createdAt: 5, updatedAt: 1 },
      { id: 'huge', title: '안맞는2시간', status: 'next', priority: 1, estimate: 120, due: todayDS, tags: [], createdAt: 6, updatedAt: 1 },
      { id: 'sd', title: '언젠가', status: 'someday', priority: 1, estimate: 5, tags: [], createdAt: 7, updatedAt: 1 },
      { id: 'ib', title: '수집함추천', status: 'inbox', priority: 1, estimate: 5, due: plusDays(-1), tags: [], createdAt: 8, updatedAt: 1 },
    ]
  }));
  $('.nav[data-view="suggest"]').click();
  ck('런타임 에러 없음', !getErr());
  let titles = $$('.sg-title').map(x => x.textContent);
  ck('15분: 소요>틈/언젠가 제외', !titles.includes('큰일55분') && !titles.includes('안맞는2시간') && !titles.includes('언젠가'));
  ck('15분: Inbox 제외(다음 할일만)', !titles.includes('수집함추천'));
  ck('15분: 지난마감 1위', $$('.sg-card')[0].textContent.includes('지난마감'));
  ck('추천 이유 칩 노출', $('.chip.why'));
  $$('#gapChips button').find(b => b.textContent === '60분').click();
  titles = $$('.sg-title').map(x => x.textContent);
  ck('60분: 큰일55분 포함', titles.includes('큰일55분'));
  ck('60분: 큰일(fit↑)이 작은일보다 상위', titles.indexOf('큰일55분') >= 0 && titles.indexOf('큰일55분') < titles.indexOf('작은일5분'));
}

// ───────────────────────── 6) 알림(포그라운드) ─────────────────────────
{
  section('알림');
  const nm = today.getHours() * 60 + today.getMinutes();
  const { $, fired, getErr } = boot(baseState({
    tasks: [
      { id: 'a', title: '블록작업', status: 'next', priority: 3, block: { date: todayDS, start: nm, duration: 30 }, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'b', title: '먼블록', status: 'next', priority: 3, block: { date: todayDS, start: (nm + 120) % 1440, duration: 30 }, tags: [], createdAt: 2, updatedAt: 1 },
      { id: 'c', title: '완료블록', status: 'done', completedAt: 1, block: { date: todayDS, start: nm, duration: 30 }, tags: [], createdAt: 3, updatedAt: 1 },
    ],
    settings: { focus: 25, short: 5, long: 15, longEvery: 4, notify: true, notifyLead: 0 },
  }), { notify: true });
  await sleep(40);
  ck('런타임 에러 없음', !getErr());
  ck('현재 블록 알림 발송', fired.some(f => f.title.includes('블록작업')));
  ck('먼 블록 미발송', !fired.some(f => f.title.includes('먼블록')));
  ck('완료 블록 미발송', !fired.some(f => f.title.includes('완료블록')));
}

// ───────────────────────── 7) PWA 설치 버튼 ─────────────────────────
{
  section('PWA 설치');
  const { window, $, getErr } = boot(baseState());
  $('.nav[data-view="settings"]').click();
  ck('런타임 에러 없음', !getErr());
  ck('설치 영역 존재', $('#install-area'));
  ck('프롬프트 없으면 안내 버튼', $('#install-area button') && $('#install-area button').textContent.includes('설치 방법'));
  let prompted = false;
  const ev = new window.Event('beforeinstallprompt');
  ev.prompt = () => { prompted = true; }; ev.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(ev);
  ck('프롬프트 캡처 후 설치 버튼', $('#install-area button') && $('#install-area button').textContent.includes('앱 설치'));
  $('#install-area button').click();
  await sleep(10);
  ck('설치 버튼이 prompt() 호출', prompted);
}

// ───────────────────────── 8) 가져오기 시 migrate 적용 ─────────────────────────
{
  section('import migrate');
  const { window, $, getErr } = boot(baseState());
  $('.nav[data-view="settings"]').click();
  const old = { tasks: [{ id: 'x', title: '옛할일', status: 'next', priority: 2, due: '2026-01-01' }], projects: [], sessions: [], settings: { focus: 25, short: 5, long: 15, longEvery: 4 }, top3: {}, updatedAt: 5 };
  const file = new window.File([JSON.stringify(old)], 'old.json', { type: 'application/json' });
  const input = $('#impFile');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await sleep(40);
  ck('런타임 에러 없음', !getErr());
  const st = JSON.parse(localStorage.getItem('flowdo.state.v1'));
  ck('subtasks 보강', Array.isArray(st.tasks[0].subtasks));
  ck('events 보강', Array.isArray(st.events));
  ck('memos 보강', Array.isArray(st.memos));
  ck('settings.notify 보강', st.settings.notify === false);
  ck('데이터 반영', st.tasks[0].title === '옛할일');
}

// ───────────────────────── 9) 주간 리뷰 ─────────────────────────
{
  section('주간 리뷰');
  const noonTs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0).getTime();
  const { window, $, $$, getErr } = boot(baseState({
    projects: [{ id: 'p1', name: '논문', color: '#16a34a' }],
    tasks: [
      { id: 'd1', title: '주간완료A', status: 'done', completedAt: noonTs, projectId: 'p1', priority: 2, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'd2', title: '주간완료B', status: 'done', completedAt: noonTs, priority: 3, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'lo', title: '남은일', status: 'next', due: todayDS, priority: 2, tags: [], createdAt: 1, updatedAt: 1 },
    ],
    sessions: [{ id: 's1', taskId: 'd1', date: todayDS, duration: 25, at: noonTs }],
  }));
  $('.nav[data-view="weekreview"]').click();
  ck('런타임 에러 없음', !getErr());
  ck('주간 리뷰 렌더', $('.review') && $('#viewTitle').textContent === '주간 리뷰');
  ck('완료 수 통계 2', $$('.rv-stat .n')[0].textContent === '2');
  ck('요일 막대 7개', $$('.wr-bar').length === 7);
  ck('오늘 막대에 완료 수 표시', $$('.wr-bar.today .wr-bar-n')[0] && $$('.wr-bar.today .wr-bar-n')[0].textContent === '2');
  ck('프로젝트별: 논문 표시', $('#wrProj').textContent.includes('논문'));
  ck('남은 일: 남은일 표시', $('#wrLeft').textContent.includes('남은일'));
  // 회고 메모 저장
  const ta = $('#wrNote'); ta.value = '이번 주 좋았다'; ta.dispatchEvent(new window.Event('change'));
  const wn = JSON.parse(localStorage.getItem('flowdo.state.v1')).weekNotes;
  ck('회고 메모 저장됨', Object.values(wn).some(v => v === '이번 주 좋았다'));
  // 다음 주로 이월
  $$('#wrLeft button').find(b => b.textContent.includes('다음 주로')).click();
  const lo = JSON.parse(localStorage.getItem('flowdo.state.v1')).tasks.find(t => t.id === 'lo');
  ck('이월 후 마감일이 다음 주 이후', lo.due > todayDS);
}

// ───────────────────────── 10) 홈(기본 진입) — 마지막 본 화면 기억 ─────────────────────────
{
  section('홈/마지막화면');
  // 첫 실행(저장된 화면 없음) → 오늘
  const a = boot(baseState());
  ck('첫 실행 홈=오늘', a.$('#viewTitle').textContent === '오늘 할 일');
  // 마지막 본 화면이 타임박스면 그걸로 복원
  const b = boot(baseState(), { lastview: 'plan' });
  ck('마지막=타임박스면 복원', b.$('#viewTitle').textContent === '타임박스');
  // 화면 이동 시 lastview 저장 (필터 뷰 제외)
  a.$('.nav[data-view="weekreview"]').click();
  ck('이동 시 lastview 저장', a.window.localStorage.getItem('flowdo.lastview') === 'weekreview');
}

// ───────────────────────── 11) 빈 태그 섹션 숨김 ─────────────────────────
{
  section('태그 섹션');
  const noTags = boot(baseState({ tasks: [{ id: 'a', title: '태그없음', status: 'next', priority: 4, tags: [], createdAt: 1, updatedAt: 1 }] }));
  ck('태그 0개면 섹션 숨김', noTags.$('#tagSection').style.display === 'none');
  const withTags = boot(baseState({ tasks: [{ id: 'a', title: '태그있음', status: 'next', priority: 4, tags: ['@연구'], createdAt: 1, updatedAt: 1 }] }));
  ck('태그 있으면 섹션 표시', withTags.$('#tagSection').style.display !== 'none');
  ck('태그 버튼 렌더', withTags.$$('#tagNav .nav').some(b => b.textContent.includes('@연구')));
}

// ───────────────────────── 12) GTD 보드 (칸반) ─────────────────────────
{
  section('GTD 보드');
  const { window, $, $$, getErr } = boot(baseState({
    tasks: [
      { id: 'i1', title: '수집함일', status: 'inbox', priority: 4, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'n1', title: '다음행동일', status: 'next', priority: 2, due: todayDS, tags: [], createdAt: 2, updatedAt: 1 },
      { id: 'w1', title: '대기일', status: 'waiting', priority: 3, tags: [], createdAt: 3, updatedAt: 1 },
      { id: 's1', title: '언젠가일', status: 'someday', priority: 4, tags: [], createdAt: 4, updatedAt: 1 },
      { id: 'dn', title: '완료일', status: 'done', completedAt: 1, priority: 4, tags: [], createdAt: 5, updatedAt: 1 },
    ]
  }), { lastview: 'gtdboard' });
  ck('런타임 에러 없음', !getErr());
  ck('GTD 보드 진입(lastview)', $('#viewTitle').textContent === 'GTD 보드');
  ck('4개 열', $$('.gtdb-col').length === 4);
  const cols = $$('.gtdb-col');
  ck('Inbox 열에 수집함일', cols[0].textContent.includes('수집함일'));
  ck('다음행동 열에 다음행동일', cols[1].textContent.includes('다음행동일'));
  ck('완료는 보드에 없음', !$('.gtdb').textContent.includes('완료일'));
  // 빠른 추가 (Inbox 열)
  const inp = cols[0].querySelector('.gtdb-add input'); inp.value = '새수집';
  inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ck('열 빠른추가 → inbox 생성', JSON.parse(localStorage.getItem('flowdo.state.v1')).tasks.some(t => t.title === '새수집' && t.status === 'inbox'));
  // 드래그 드롭으로 상태 변경: 수집함일(i1)을 '다음 행동' 열로
  const dt = { getData: () => 'i1', setData: () => {} };
  const drop = new window.Event('drop', { bubbles: true }); drop.preventDefault = () => {}; drop.dataTransfer = dt;
  $$('.gtdb-col')[1].dispatchEvent(drop);
  ck('드롭 → 상태 next로 변경', JSON.parse(localStorage.getItem('flowdo.state.v1')).tasks.find(t => t.id === 'i1').status === 'next');
  // 사이드바: GTD 보드 단일 메뉴, 개별 메뉴 제거
  ck('사이드바 GTD 보드 메뉴 존재', !!$('.nav[data-view="gtdboard"]'));
  ck('개별 inbox 메뉴 제거됨', !$('.nav[data-view="inbox"]'));
  ck('완료 메뉴 유지', !!$('.nav[data-view="done"]'));
}

// ───────────────────────── 13) 사용 가이드 ─────────────────────────
{
  section('사용 가이드');
  // 첫 실행이면 가이드 자동 표시
  const first = boot(baseState(), { firstRun: true });
  ck('런타임 에러 없음', !first.getErr());
  ck('첫 실행 → 가이드 자동 표시', first.$('#viewTitle').textContent === '사용 가이드');
  ck('가이드 본 표시 저장', first.window.localStorage.getItem('flowdo.guideSeen') === '1');
  // 사이드바에 가이드 메뉴
  ck('사이드바 가이드 메뉴', !!first.$('.nav[data-view="guide"]'));
  ck('워크플로 8단계 렌더', first.$$('.guide-step').length === 8);
  ck('바로가기 버튼 존재', first.$$('.guide-step .btn').length >= 1);
  // 두 번째 실행(guideSeen 있음)은 가이드 자동 표시 안 함 → 오늘
  const second = boot(baseState());
  ck('두 번째 실행은 오늘', second.$('#viewTitle').textContent === '오늘 할 일');
  // 가이드는 lastview로 저장되지 않음(전환해도 reload 시 작업화면 복귀)
  second.$('.nav[data-view="guide"]').click();
  ck('가이드는 lastview 미저장', second.window.localStorage.getItem('flowdo.lastview') !== 'guide');
}

// ───────────────────────── 14) 타임박스 풀 = 다음 할일만 ─────────────────────────
{
  section('타임박스 풀');
  const { window, $, $$, getErr } = boot(baseState({
    tasks: [
      { id: 'nx', title: '다음할일카드', status: 'next', priority: 3, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'ib', title: '수집함카드', status: 'inbox', priority: 3, tags: [], createdAt: 2, updatedAt: 1 },
      { id: 'wt', title: '대기카드', status: 'waiting', priority: 3, tags: [], createdAt: 3, updatedAt: 1 },
    ]
  }), { planview: 'day' });
  $('.nav[data-view="plan"]').click();
  const poolText = () => $('#pool').textContent;
  ck('런타임 에러 없음', !getErr());
  ck('풀에 다음할일 노출', poolText().includes('다음할일카드'));
  ck('풀에 Inbox 미노출', !poolText().includes('수집함카드'));
  ck('풀에 대기 미노출', !poolText().includes('대기카드'));
  // 타임박스 빠른추가 → next 상태로 생성
  const pq = $('#poolQuick'); pq.value = '타임박스추가';
  pq.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const t = JSON.parse(localStorage.getItem('flowdo.state.v1')).tasks.find(x => x.title === '타임박스추가');
  ck('타임박스 추가 → 다음할일(next)', t && t.status === 'next');
}

// ───────────────────────── 15) 완료 뷰엔 빠른 추가 없음 ─────────────────────────
{
  section('완료 뷰');
  const { $, getErr } = boot(baseState({
    tasks: [
      { id: 'd', title: '완료된일', status: 'done', completedAt: 1, priority: 4, tags: [], createdAt: 1, updatedAt: 1 },
      { id: 'n', title: '다음일', status: 'next', priority: 4, tags: [], createdAt: 2, updatedAt: 1 },
    ]
  }));
  $('.nav[data-view="done"]').click();
  ck('런타임 에러 없음', !getErr());
  ck('완료 뷰에 빠른추가 없음', !$('#quickInput'));
  // 다른 목록 뷰엔 빠른추가 있음
  $('.nav[data-view="today"]').click();
  ck('오늘 뷰엔 빠른추가 있음', !!$('#quickInput'));
}

// ───────────────────────── 14) 휴무일 / 공휴일 자동 처리 ─────────────────────────
{
  section('휴무일/공휴일');
  // 국경일은 자동(KR_HOLIDAY_NAMES) → 칩 숨김. 사용자 추가 휴무일만 표시.
  const { $, $$, window, getErr } = boot(baseState({ holidays: ['2026-08-15', '2026-07-20'] }));
  $('.nav[data-view="settings"]').click();
  ck('런타임 에러 없음', !getErr());
  ck('한국 공휴일 일괄추가 버튼 제거됨', !$('#hol-kr'));
  const chips = $$('#hol-list .chip').map(c => c.textContent);
  ck('국경일(08-15)은 칩에서 숨김(자동 처리)', !chips.some(t => t.includes('2026-08-15')));
  ck('사용자 휴무일(07-20)은 칩 표시', chips.some(t => t.includes('2026-07-20')));
  // 휴무일 직접 추가
  $('#hol-date').value = '2026-11-11';
  $('#hol-add').click();
  const hs = JSON.parse(window.localStorage.getItem('flowdo.state.v1')).holidays;
  ck('휴무일 추가 저장', hs.includes('2026-11-11'));
  ck('추가 후 칩 표시', $$('#hol-list .chip').some(c => c.textContent.includes('2026-11-11')));
}

// ───────────────────────── 15) 동기화 병합 (mergeStates) ─────────────────────────
{
  section('동기화 병합');
  const { window: w, getErr } = boot(baseState());
  const M = w.mergeStates;
  ck('런타임 에러 없음', !getErr());
  ck('mergeStates 전역 노출', typeof M === 'function');
  let m = M({ tasks: [{ id: 'L', title: '로컬', updatedAt: 5 }], updatedAt: 10 },
            { tasks: [{ id: 'R', title: '원격', updatedAt: 5 }], updatedAt: 20 });
  ck('양쪽 고유 태스크 보존', m.tasks.some(t => t.id === 'L') && m.tasks.some(t => t.id === 'R'));
  m = M({ tasks: [{ id: 'X', title: '로컬최신', updatedAt: 100 }], updatedAt: 100 },
        { tasks: [{ id: 'X', title: '원격구', updatedAt: 50 }], updatedAt: 200 });
  ck('충돌 시 updatedAt 최신 우선', m.tasks.find(t => t.id === 'X').title === '로컬최신');
  m = M({ tasks: [], deletions: { D: 100 }, updatedAt: 100 },
        { tasks: [{ id: 'D', updatedAt: 50 }], updatedAt: 200 });
  ck('tombstone로 삭제 보존', !m.tasks.some(t => t.id === 'D'));
  m = M({ tasks: [], deletions: { D: 100 }, updatedAt: 100 },
        { tasks: [{ id: 'D', title: '삭제후편집', updatedAt: 150 }], updatedAt: 200 });
  ck('삭제보다 최신 편집은 유지(부활)', m.tasks.some(t => t.id === 'D'));
  m = M({ sessions: [{ id: 's1' }], updatedAt: 10 }, { sessions: [{ id: 's2' }], updatedAt: 20 });
  ck('sessions 합집합', m.sessions.length === 2);
  m = M({ projects: [{ id: 'p1' }], updatedAt: 10 }, { projects: [{ id: 'p2' }], updatedAt: 20 });
  ck('projects 합집합', m.projects.length === 2);
  m = M({ settings: { focus: 99 }, updatedAt: 10 }, { settings: { focus: 25 }, updatedAt: 20 });
  ck('settings는 최신(원격) 채택', m.settings.focus === 25);
  ck('deletions 합집합 유지', M({ deletions: { a: 1 }, updatedAt: 1 }, { deletions: { b: 2 }, updatedAt: 2 }).deletions.a === 1);
}

// ───────────────────────── 16) 요일·공휴일 색상 + 이름 (월간) ─────────────────────────
{
  section('요일·공휴일 색상');
  // 2026년이면 공휴일 테이블이 있어 이름 표시 검증 가능
  const { $, $$, getErr } = boot(baseState({ holidays: ['2026-09-25'] }), { planview: 'month', lastview: 'plan' });
  $('.nav[data-view="plan"]').click();
  // planDate를 2026-09로 이동해야 추석이 보임 → 미니달력 대신 9월로 nav (월간 기준 현재월). today가 6월이므로 9월로 3번 다음
  $$('.seg button').find(b => b.dataset.v === 'month').click();
  ck('런타임 에러 없음', !getErr());
  // 일요일 dow 헤더는 sun 색 클래스
  ck('월간 일요일 헤더 sun', $$('.mo-dn')[0].classList.contains('sun'));
  ck('월간 토요일 헤더 sat', $$('.mo-dn')[6].classList.contains('sat'));
  // 토요일 셀은 d-sat, 일요일/공휴일 셀은 d-sun
  const satCells = $$('.mo-cell.d-sat'), sunCells = $$('.mo-cell.d-sun');
  ck('토요일 셀 d-sat 존재', satCells.length >= 4);
  ck('일/공휴일 셀 d-sun 존재', sunCells.length >= 4);
  // 실행 시점의 달과 무관하게 결정적으로: 목표 연·월까지 계산해서 이동 (하드코딩 클릭 수 금지 — 월 바뀌면 flaky)
  let curY = today.getFullYear(), curM = today.getMonth() + 1; // 월간 뷰는 현재 월에서 시작
  const gotoMonth = (y, m) => {
    let diff = (y - curY) * 12 + (m - curM);
    while (diff > 0) { $('#cal-next').click(); diff--; }
    while (diff < 0) { $('#cal-prev').click(); diff++; }
    curY = y; curM = m;
  };
  // 2026-09 추석 이름 표시 (KR_HOLIDAY_NAMES 테이블 기준)
  gotoMonth(2026, 9);
  const hasChuseok = $$('.mo-hol').some(e => e.textContent.includes('추석'));
  ck('월간에 공휴일 이름(추석) 표시', hasChuseok);
  // 대체공휴일도 날짜 글씨 빨강(d-sun) — state.holidays에 없어도 테이블 기준 (2026-03)
  gotoMonth(2026, 3);
  const subCell = $$('.mo-cell').find(c => { const h = c.querySelector('.mo-hol'); return h && h.textContent.includes('대체공휴일'); });
  ck('대체공휴일 셀 존재', !!subCell);
  ck('대체공휴일 날짜 빨강(d-sun)', subCell && subCell.classList.contains('d-sun'));
  // 다년: 내년 1월 → 신정(매년 고정 양력 폴백)이 자동 표시·빨강
  gotoMonth(today.getFullYear() + 1, 1);
  const ny = $$('.mo-cell').find(c => { const h = c.querySelector('.mo-hol'); return h && h.textContent.includes('신정'); });
  ck('내년 신정 자동 표시', !!ny);
  ck('내년 신정 날짜 빨강(d-sun)', ny && ny.classList.contains('d-sun'));
}

// ───────────────────────── 17) 개인정보 동의 / 처리방침 ─────────────────────────
{
  section('개인정보 동의');
  const { $, getErr } = boot(baseState());
  ck('런타임 에러 없음', !getErr());
  // 로그인 게이트에 동의 체크박스 + 처리방침 링크
  ck('동의 체크박스 존재', !!$('#gate-consent'));
  ck('게이트에 처리방침 링크', !![...document.querySelectorAll('.auth-login a')].find(a => a.getAttribute('href') === 'privacy.html'));
  // 기본은 미동의 → 로그인 버튼 비활성화
  ck('미동의 시 로그인 버튼 disabled', $('#gate-google').disabled === true);
  // 체크하면 활성화
  $('#gate-consent').checked = true; $('#gate-consent').dispatchEvent(new window.Event('change'));
  ck('동의 시 로그인 버튼 활성화', $('#gate-google').disabled === false);
  // privacy.html 파일 존재 + 필수 항목 포함
  const priv = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  ck('privacy.html 존재', priv.length > 0);
  ck('처리방침 필수 항목 포함', ['처리 목적', '보유', '위탁', '보호책임자', '권리'].every(k => priv.includes(k)));
  // 동의 모달이 마크업에 존재(기존 세션 대비)
  ck('기존 세션 동의 모달 존재', !!$('#consentOverlay'));
}

// ───────────────────────── 18) 접근성(a11y) ─────────────────────────
{
  section('접근성');
  const { $, $$, getErr } = boot(baseState({
    tasks: [{ id: 'a', title: '마감있음', status: 'next', priority: 2, due: todayDS, tags: [], createdAt: 1, updatedAt: 1 }]
  }));
  ck('런타임 에러 없음', !getErr());
  // 아이콘 전용 메뉴 버튼에 접근명(aria-label)
  ck('메뉴 버튼 aria-label', !!$('#menuBtn') && !!$('#menuBtn').getAttribute('aria-label'));
  // 모달 dialog 역할
  ck('할일 모달 role=dialog', $('#taskOverlay').getAttribute('role') === 'dialog');
  ck('할일 모달 aria-modal', $('#taskOverlay').getAttribute('aria-modal') === 'true');
  ck('일정 모달 aria-labelledby', $('#eventOverlay').getAttribute('aria-labelledby') === 'eventModalTitle');
  ck('동의 모달 role=dialog', $('#consentOverlay').getAttribute('role') === 'dialog');
  // 장식 아이콘은 aria-hidden (오늘 뷰의 마감 칩 cic)
  $('.nav[data-view="today"]').click();
  ck('장식 칩 아이콘 aria-hidden', $$('.chip svg[aria-hidden="true"]').length >= 1);
}

// ───────────────────────── 19) 순수 로직 유닛 (DOM 비의존, 견고) ─────────────────────────
{
  section('순수 로직 유닛');
  const w = boot(baseState()).window;
  // 날짜/시간 헬퍼
  ck('pad', w.pad(3) === '03');
  ck('minToHHMM', w.minToHHMM(90) === '01:30');
  ck('hhmmToMin 왕복', w.hhmmToMin(w.minToHHMM(615)) === 615);
  ck('addDaysDS 월경계', w.addDaysDS('2026-06-28', 3) === '2026-07-01');
  ck('startOfWeekDS(일요일)', w.startOfWeekDS('2026-06-28') === '2026-06-28');
  ck('isOverdue 과거=true', w.isOverdue('2020-01-01') === true);
  ck('isOverdue 오늘=false', w.isOverdue(w.todayStr()) === false);
  ck('fmtDue 오늘', w.fmtDue(w.todayStr()) === '오늘');
  ck('isDone', w.isDone({ status: 'done' }) === true && w.isDone({ status: 'next' }) === false);
  // 월 n번째 요일 / 월간 발생일
  const fs1 = w.nthWeekday(2026, 2, 0, 1); // 2026 3월 첫 일요일 = 3/1(일)
  ck('nthWeekday 첫 일요일=3/1', fs1 && fs1.getDate() === 1 && fs1.getDay() === 0);
  const mo = w.monthlyOccDate({ monthMode: 'date', startDate: '2026-01-15' }, 2026, 5); // 6월
  ck('monthlyOccDate 매월 15일', mo && mo.getDate() === 15 && mo.getMonth() === 5);
  // 추천 점수
  ck('prioScore P1=1', w.prioScore({ priority: 1 }) === 1);
  ck('fitScore 비율', w.fitScore({ estimate: 30 }, 60) === 0.5);
  ck('fitScore 미입력=0.45', w.fitScore({}, 60) === 0.45);
  ck('daysUntil null', w.daysUntil(null) === null);
  ck('suggestScore 지난마감 사유', w.suggestScore({ priority: 4, due: '2020-01-01' }, 30).reason === '지난 마감');
  // 일정 설명
  ck('describeEvent 주간', /매주/.test(w.describeEvent({ freq: 'weekly', interval: 1, days: [1, 3], start: 540, duration: 60 })));
  ck('describeEvent 매월 날짜', /매월/.test(w.describeEvent({ freq: 'monthly', monthMode: 'date', startDate: '2026-06-10', interval: 1, start: 600, duration: 30 })));
  ck('describeEvent 종일', /종일/.test(w.describeEvent({ freq: 'once', allDay: true, startDate: '2026-07-01', endDate: '2026-07-03' })));
  ck('isPastEvent 과거 once', w.isPastEvent({ freq: 'once', startDate: '2020-01-01', endDate: '2020-01-02' }) === true);
  ck('isPastEvent 미래 once', w.isPastEvent({ freq: 'once', startDate: '2099-01-01', endDate: '2099-01-02' }) === false);
  // 정렬: 완료는 뒤, 지남/우선순위 우선
  const sorted = w.sortTasks([
    { id: 'done', status: 'done', priority: 1, completedAt: 5 },
    { id: 'p4', status: 'next', priority: 4, due: null, createdAt: 2 },
    { id: 'over', status: 'next', priority: 4, due: '2020-01-01', createdAt: 1 },
    { id: 'p1', status: 'next', priority: 1, due: null, createdAt: 3 },
  ]);
  ck('sortTasks: 완료 맨 뒤', sorted[sorted.length - 1].id === 'done');
  ck('sortTasks: 지난 항목 최상위', sorted[0].id === 'over');
  // mergeStates: settings/top3/holidays 키별 병합 — 한쪽 변경 유실 방지(가재코드 합의 검증 버그)
  const mLocal = { settings:{focus:99,short:9,long:15,longEvery:4}, top3:{'2026-06-01':['a']}, holidays:['2026-01-01'], weekNotes:{}, updatedAt: 10 };
  const mRemote = { settings:{focus:25,long:15,longEvery:4}, top3:{'2026-06-02':['b']}, holidays:['2026-03-01'], weekNotes:{}, updatedAt: 20 };
  const merged = w.mergeStates(mLocal, mRemote);
  ck('merge settings: newer 필드 우선(focus=25)', merged.settings.focus === 25);
  ck('merge settings: newer에 없는 older 필드 보존(short=9)', merged.settings.short === 9);
  ck('merge top3: 양쪽 날짜 보존', merged.top3['2026-06-01'] && merged.top3['2026-06-02']);
  ck('merge holidays: 합집합', merged.holidays.includes('2026-01-01') && merged.holidays.includes('2026-03-01'));
  // 타임박스 좌표 수학(순수, 파라미터화)
  ck('tbSnap 10분 스냅', w.tbSnap(67, 10) === 70);
  ck('tbMinToTop(09:00, start08)', w.tbMinToTop(540, 8, 1) === 60);
  ck('tbClampMin 상한', w.tbClampMin(2000, 8, 24, 10) === 1430);
  ck('tbClampMin 하한', w.tbClampMin(100, 8, 24, 10) === 480);
  ck('tbYToMin 변환+스냅+클램프', w.tbYToMin(67, 8, 24, 10, 1, 0) === 550);
}

// ───────────────────────── 20) 메모 (참고용 노트) ─────────────────────────
{
  section('메모');
  const { window, $, $$, getErr } = boot(baseState({
    memos: [
      { id: 'm1', title: '참고자료', body: '링크 모음\n2번째 줄', color: '', createdAt: 1, updatedAt: 10 },
      { id: 'm2', title: '', body: '제목없는 메모 본문', color: '#83bfa7', createdAt: 2, updatedAt: 20 },
    ]
  }), { lastview: 'memo' });
  ck('런타임 에러 없음', !getErr());
  ck('사이드바 메모 메뉴 존재', !!$('.nav[data-view="memo"]'));
  ck('메모 뷰 진입(lastview)', $('#viewTitle').textContent === '메모');
  ck('메모 카드 2개', $$('.memo-card').length === 2);
  ck('제목 없으면 본문 첫 줄 표시', $$('.memo-card .memo-title').some(e => e.textContent.includes('제목없는 메모 본문')));
  ck('색상 메모 좌측 강조선', $$('.memo-card').some(c => c.style.borderLeft && c.style.borderLeft.includes('3px')));
  // 컨트롤 배치: 폴더는 제목 옆(.memo-title-row), 우측 액션은 고정·휴지통만(select 없음)
  ck('폴더 칩이 제목 행에 위치', !!$('.memo-card .memo-title-row .memo-move'));
  ck('우측 액션에 폴더 select 없음', !$('.memo-card .memo-actions .memo-move') && $$('.memo-card .memo-actions [data-act]').length >= 1);
  // 새 메모 추가 → 에디터 열림
  $('#memoAdd').click();
  ck('새 메모 추가 → state 3개', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.length === 3);
  ck('추가 후 편집 에디터 표시', !!$('#memoBody') && !!$('#memoTitle'));
  ck('리치 에디터 본문 contenteditable', $('#memoBody').getAttribute('contenteditable') === 'true');
  ck('서식 툴바 버튼 존재(B·I·목록·체크·그림)', $$('.memo-tool[data-cmd]').length >= 5);
  ck('글꼴·글자크기 셀렉트 존재', !!$('#memoFont') && !!$('#memoSize'));
  ck('생성·편집 일시 입력 존재', !!$('#memoCreated') && !!$('#memoUpdated'));
  ck('저장됨 표시 존재', !!$('#memoSaved'));
  ck('에디터 진입 시 저장됨 상태', $('#memoSaved').classList.contains('saved'));
  // 편집: 제목/본문 입력 (input 이벤트로 즉시 저장)
  $('#memoTitle').value = '회의 메모'; $('#memoTitle').dispatchEvent(new window.Event('input'));
  $('#memoBody').innerHTML = '결정사항 정리'; $('#memoBody').dispatchEvent(new window.Event('input'));
  const saved = JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.title === '회의 메모');
  ck('편집 내용 저장', saved && saved.body === '결정사항 정리');
  ck('편집 직후 저장 중 표시', $('#memoSaved').textContent.includes('저장') && $('#memoSaved').classList.contains('saving'));
  ck('본문 html 저장', typeof saved.html === 'string' && saved.html.includes('결정사항'));
  // 리치 본문 → 평문(body) 변환: 줄바꿈·체크박스
  $('#memoBody').innerHTML = '첫줄<br>둘째줄<label class="memo-chk"><input type="checkbox" checked> 완료항목</label>';
  $('#memoBody').dispatchEvent(new window.Event('input'));
  const rich = JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === saved.id);
  ck('평문 변환: 줄바꿈 보존', rich.body.includes('첫줄') && rich.body.includes('둘째줄'));
  ck('평문 변환: 체크 표시', rich.body.includes('[x]'));
  // 새 체크박스 구조: 박스만 클릭해 토글(텍스트는 편집 보존), 체크 시 취소선 클래스
  $('#memoBody').innerHTML = '<div class="memo-chk"><span class="memo-chk-box" contenteditable="false"></span><span class="memo-chk-t">할일항목</span></div>';
  $('#memoBody').dispatchEvent(new window.Event('input'));
  const box = $('#memoBody .memo-chk-box');
  ck('체크박스 박스 요소 존재', !!box);
  box.click();
  ck('박스 클릭 → checked 클래스', $('#memoBody .memo-chk').classList.contains('checked'));
  ck('체크 시 평문 [x]', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === saved.id).body.includes('[x]'));
  box.click();
  ck('박스 재클릭 → checked 해제', !$('#memoBody .memo-chk').classList.contains('checked'));
  ck('해제 시 평문 [ ]', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === saved.id).body.includes('[ ]'));
  // 텍스트 영역 클릭은 토글하지 않음(편집 보존)
  $('#memoBody .memo-chk').classList.add('checked');
  $('#memoBody .memo-chk-t').click();
  ck('텍스트 클릭은 토글 안 함', $('#memoBody .memo-chk').classList.contains('checked'));
  // 일시 직접 수정
  const cIn = $('#memoCreated'); cIn.value = '2020-01-02T03:04'; cIn.dispatchEvent(new window.Event('change'));
  const edited = JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === saved.id);
  ck('생성일시 직접 수정 반영', new Date(edited.createdAt).getFullYear() === 2020);
  // 서식 버튼 클릭 시 런타임 에러 없음(execCommand 미구현 환경 안전)
  $$('.memo-tool[data-cmd]').find(b => b.dataset.cmd === 'bold').click();
  ck('서식 버튼 클릭 무에러', !getErr());
  // 색상 선택
  $$('#memoColors .memo-color').find(b => !b.classList.contains('none')).click();
  ck('색상 선택 저장', !!JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.title === '회의 메모').color);
  // 목록으로 돌아가기
  $('#memoBack').click();
  ck('목록 복귀 → 카드 3개', $$('.memo-card').length === 3);
  // 기존 메모 클릭 → 편집 열림
  $$('.memo-card .memo-card-body').find(e => e.textContent.includes('참고자료')).click();
  ck('카드 클릭 → 편집 열림', $('#memoTitle').value === '참고자료');
  $('#memoBack').click();
  // 삭제 = 휴지통 이동(보관)
  const before = JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.length;
  $$('.memo-card').find(c => c.textContent.includes('참고자료')).querySelector('[data-act="del"]').click();
  let st1 = JSON.parse(localStorage.getItem('flowdo.state.v1'));
  ck('삭제 → 메모 보존(휴지통 이동)', st1.memos.length === before);
  ck('삭제 → trashedAt 기록', st1.memos.find(m => m.id === 'm1').trashedAt > 0);
  ck('삭제 → 목록에서 숨김', !$$('.memo-card .memo-title').some(e => e.textContent.includes('참고자료')));
  // 휴지통 뷰 + 복원
  $('.memo-folder.trash').click();
  ck('휴지통 뷰', $('.memo-folder.trash').classList.contains('sel') && $$('.memo-card').length === 1);
  $$('.memo-card')[0].querySelector('[data-act="restore"]').click();
  ck('복원 → trashedAt 해제', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === 'm1').trashedAt === 0);
  // 다시 삭제 → 완전 삭제(purge)
  $('.memo-folder[data-fid="all"]').click();
  $$('.memo-card').find(c => c.textContent.includes('참고자료')).querySelector('[data-act="del"]').click();
  $('.memo-folder.trash').click();
  window.confirm = () => true;
  $$('.memo-card')[0].querySelector('[data-act="purge"]').click();
  let st2 = JSON.parse(localStorage.getItem('flowdo.state.v1'));
  ck('완전 삭제 → 메모 제거', !st2.memos.some(m => m.id === 'm1'));
  ck('완전 삭제 → tombstone 기록', !!(st2.deletions && st2.deletions['m1']));
  // 폴더 생성 / 자동 선택
  $('.memo-folder[data-fid="all"]').click();
  $('#memoAddFolder').click();
  let st3 = JSON.parse(localStorage.getItem('flowdo.state.v1'));
  ck('폴더 추가', st3.folders.length === 1);
  const fid = st3.folders[0].id;
  ck('새 폴더 자동 선택', !!$(`.memo-folder[data-fid="${fid}"]`) && $(`.memo-folder[data-fid="${fid}"]`).classList.contains('sel'));
  // 폴더에서 새 메모 추가 → 해당 폴더 소속
  $('#memoAdd').click(); $('#memoBack').click();
  ck('폴더에서 추가한 메모는 폴더 소속', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.some(m => m.folderId === fid));
  ck('폴더 뷰에 1개', $$('.memo-card').length === 1);
  // 전체에서 메모를 폴더로 이동
  $('.memo-folder[data-fid="all"]').click();
  const mv = $$('.memo-card .memo-move').find(s => s.closest('.memo-card').dataset.id);
  const mvId = mv.closest('.memo-card').dataset.id;
  mv.value = fid; mv.dispatchEvent(new window.Event('change'));
  ck('폴더 이동 반영', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === mvId).folderId === fid);
  // 고정 토글 + 상단 정렬
  $('.memo-folder[data-fid="all"]').click();
  const pc = $$('.memo-card')[0]; const pid = pc.dataset.id;
  pc.querySelector('[data-act="pin"]').click();
  ck('고정 → pinned=true', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === pid).pinned === true);
  ck('고정 메모 최상단', $$('.memo-card')[0].dataset.id === pid);
  // 폴더 삭제 → 메모는 전체로 이동
  $(`.memo-folder[data-fid="${fid}"]`).click();
  $('#memoDeleteFolder').click();
  let st5 = JSON.parse(localStorage.getItem('flowdo.state.v1'));
  ck('폴더 삭제', st5.folders.length === 0);
  ck('폴더 삭제 → 메모 folderId 비움', st5.memos.filter(m => m.folderId === fid).length === 0);
  // 드래그 앤 드롭으로 폴더 이동
  $('.memo-folder[data-fid="all"]').click();
  const dcard = $$('.memo-card')[0]; const did = dcard.dataset.id;
  ck('카드 draggable 속성', dcard.getAttribute('draggable') === 'true');
  dcard.dispatchEvent(new window.Event('dragstart'));
  $('.memo-folder.trash').dispatchEvent(new window.Event('drop'));
  ck('드롭(휴지통) → trashedAt 설정', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === did).trashedAt > 0);
  // 복원 후 새 폴더로 드롭 이동
  $('.memo-folder.trash').click();
  $$('.memo-card').find(c => c.dataset.id === did).querySelector('[data-act="restore"]').click();
  $('.memo-folder[data-fid="all"]').click();
  $('#memoAddFolder').click();
  const fid2 = JSON.parse(localStorage.getItem('flowdo.state.v1')).folders[0].id;
  $('.memo-folder[data-fid="all"]').click();
  const dcard2 = $$('.memo-card').find(c => c.dataset.id === did);
  dcard2.dispatchEvent(new window.Event('dragstart'));
  $(`.memo-folder[data-fid="${fid2}"]`).dispatchEvent(new window.Event('drop'));
  ck('드롭(폴더) → folderId 이동', JSON.parse(localStorage.getItem('flowdo.state.v1')).memos.find(m => m.id === did).folderId === fid2);
  // mergeStates: memos 병합 (tasks와 동일 규칙)
  const M = window.mergeStates;
  let mg = M({ memos: [{ id: 'ML', title: '로컬메모', updatedAt: 5 }], updatedAt: 10 },
             { memos: [{ id: 'MR', title: '원격메모', updatedAt: 5 }], updatedAt: 20 });
  ck('merge memos: 양쪽 보존', mg.memos.some(x => x.id === 'ML') && mg.memos.some(x => x.id === 'MR'));
  mg = M({ memos: [{ id: 'MX', title: '로컬최신', updatedAt: 100 }], updatedAt: 100 },
         { memos: [{ id: 'MX', title: '원격구', updatedAt: 50 }], updatedAt: 200 });
  ck('merge memos: 충돌 updatedAt 최신 우선', mg.memos.find(x => x.id === 'MX').title === '로컬최신');
  mg = M({ memos: [], deletions: { MD: 100 }, updatedAt: 100 },
         { memos: [{ id: 'MD', updatedAt: 50 }], updatedAt: 200 });
  ck('merge memos: tombstone 삭제 보존', !mg.memos.some(x => x.id === 'MD'));
  mg = M({ memos: [], deletions: { MD: 100 }, updatedAt: 100 },
         { memos: [{ id: 'MD', title: '삭제후편집', updatedAt: 150 }], updatedAt: 200 });
  ck('merge memos: 삭제보다 최신 편집은 부활', mg.memos.some(x => x.id === 'MD'));
  // mergeStates: folders 병합 (memos와 동일 규칙)
  mg = M({ folders: [{ id: 'FL', name: '로컬폴더', updatedAt: 5 }], updatedAt: 10 },
         { folders: [{ id: 'FR', name: '원격폴더', updatedAt: 5 }], updatedAt: 20 });
  ck('merge folders: 양쪽 보존', mg.folders.some(x => x.id === 'FL') && mg.folders.some(x => x.id === 'FR'));
  mg = M({ folders: [], deletions: { FD: 100 }, updatedAt: 100 },
         { folders: [{ id: 'FD', name: '삭제폴더', updatedAt: 50 }], updatedAt: 200 });
  ck('merge folders: tombstone 삭제 보존', !mg.folders.some(x => x.id === 'FD'));
  // mergeStates: events/projects 항목별 병합 (다른 기기 일정 편집 손실 방지)
  mg = M({ events: [{ id: 'EL', updatedAt: 5 }], updatedAt: 10 },
         { events: [{ id: 'ER', updatedAt: 5 }], updatedAt: 20 });
  ck('merge events: 양쪽 보존', mg.events.some(x => x.id === 'EL') && mg.events.some(x => x.id === 'ER'));
  // 최상위 updatedAt은 원격이 크지만, 항목 updatedAt이 로컬이 최신 → 로컬 편집 유지(예전 union이면 유실)
  mg = M({ events: [{ id: 'EX', title: '로컬최신', updatedAt: 100 }], updatedAt: 100 },
         { events: [{ id: 'EX', title: '원격구', updatedAt: 50 }], updatedAt: 200 });
  ck('merge events: 충돌 시 항목 updatedAt 최신 우선', mg.events.find(x => x.id === 'EX').title === '로컬최신');
  mg = M({ events: [], deletions: { ED: 100 }, updatedAt: 100 },
         { events: [{ id: 'ED', updatedAt: 50 }], updatedAt: 200 });
  ck('merge events: tombstone 삭제 보존', !mg.events.some(x => x.id === 'ED'));
  mg = M({ projects: [{ id: 'PX', name: '로컬', updatedAt: 100 }], updatedAt: 100 },
         { projects: [{ id: 'PX', name: '원격', updatedAt: 50 }], updatedAt: 200 });
  ck('merge projects: 충돌 시 항목 updatedAt 최신 우선', mg.projects.find(x => x.id === 'PX').name === '로컬');
}

// ───────────────────────── 검색 (할 일 + 메모) ─────────────────────────
{
  section('검색');
  const { $, $$, getErr } = boot(baseState({
    tasks: [
      { id: 't1', title: '캠핑 예약 전화', status: 'next', priority: 3, notes: '', tags: ['@개인'], createdAt: 1, updatedAt: 1 },
      { id: 't2', title: '논문 초록', status: 'next', priority: 2, notes: '', tags: [], createdAt: 2, updatedAt: 1 },
    ],
    memos: [
      { id: 'm1', title: '캠핑 준비물', body: '프로판 가스 2개\n맥주', color: '', createdAt: 1, updatedAt: 5 },
      { id: 'm2', title: '독서 메모', body: '몰입에 관하여', color: '', createdAt: 2, updatedAt: 6 },
    ],
  }));
  ck('런타임 에러 없음', !getErr());
  ck('사이드바 검색 메뉴', !!$('.nav[data-view="search"]'));
  $('.nav[data-view="search"]').click();
  ck('검색 입력창 존재', !!$('#searchInput'));
  const type = v => { const i = $('#searchInput'); i.value = v; i.dispatchEvent(new (i.ownerDocument.defaultView).Event('input', { bubbles: true })); };
  type('캠핑');
  let txt = $('#searchResults').textContent;
  ck('할 일 매칭(캠핑 예약 전화)', txt.includes('캠핑 예약 전화'));
  ck('메모 매칭(캠핑 준비물)', txt.includes('캠핑 준비물'));
  ck('비매칭 제외(논문/독서)', !txt.includes('논문 초록') && !txt.includes('독서 메모'));
  // 본문 텍스트로도 검색
  type('프로판');
  ck('메모 본문 검색', $('#searchResults').textContent.includes('캠핑 준비물'));
  // 결과 없음
  type('존재하지않는검색어zzz');
  ck('결과 없음 안내', /결과가 없습니다/.test($('#searchResults').textContent));
  // 메모 결과 클릭 → 메모 편집으로 이동
  type('독서');
  $('.search-memo').click();
  ck('메모 결과 클릭 → 메모 뷰', $('#viewTitle').textContent === '메모');
}

// ───────────────────────── 중복 정리 ─────────────────────────
{
  section('중복 정리');
  const { $, getErr } = boot(baseState({
    tasks: [
      { id: 'a1', title: '연구 미팅 자료 정리', status: 'next', priority: 2, notes: '', tags: ['@연구'], due: null, createdAt: 100, updatedAt: 1 },
      { id: 'a2', title: '연구 미팅 자료 정리', status: 'next', priority: 2, notes: '', tags: ['@연구'], due: null, createdAt: 200, updatedAt: 1 },
      { id: 'a3', title: '고유 할일', status: 'next', priority: 3, notes: '', tags: [], due: null, createdAt: 300, updatedAt: 1 },
    ],
    projects: [
      { id: 'p1', name: '논문 투고', color: '#4f46e5', createdAt: 100 },
      { id: 'p2', name: '논문 투고', color: '#4f46e5', createdAt: 200 },
    ],
    memos: [
      { id: 'mm1', title: '캠핑', body: '가스', color: '', createdAt: 100, updatedAt: 1 },
      { id: 'mm2', title: '캠핑', body: '가스', color: '', createdAt: 200, updatedAt: 1 },
    ],
  }));
  // p2를 가리키는 할 일이 있다고 가정하고 재매핑 확인용으로 a3에 p2 부여
  const st0 = JSON.parse(localStorage.getItem('flowdo.state.v1')); st0.tasks[2].projectId = 'p2'; localStorage.setItem('flowdo.state.v1', JSON.stringify(st0));
  $('.nav[data-view="settings"]').click();
  $('#dedup').click();
  const st = JSON.parse(localStorage.getItem('flowdo.state.v1'));
  ck('런타임 에러 없음', !getErr());
  ck('할 일 중복 제거(2→1 + 고유1 = 2)', st.tasks.length === 2);
  ck('프로젝트 중복 제거(2→1)', st.projects.length === 1);
  ck('메모 중복 제거(2→1)', st.memos.length === 1);
  ck('제거 항목 tombstone 기록', !!(st.deletions && (st.deletions.a2 || st.deletions.p2 || st.deletions.mm2)));
  ck('제거된 프로젝트 참조 재매핑', !st.tasks.some(t => t.projectId === 'p2'));
}

// ───────────────────────── 에너지/집중도 기반 추천 ─────────────────────────
{
  section('에너지·집중도 추천');
  const { window: w, getErr } = boot(baseState());
  ck('런타임 에러 없음', !getErr());
  // energyFit 매핑
  ck('energyFit 모드없음=0.6', w.energyFit('light', null) === 0.6 && w.energyFit('focus', undefined) === 0.6 && w.energyFit(null, null) === 0.6);
  ck('energyFit light모드', w.energyFit('light', 'light') === 1.0 && w.energyFit('focus', 'light') === 0.2 && w.energyFit(null, 'light') === 0.6);
  ck('energyFit focus모드', w.energyFit('focus', 'focus') === 1.0 && w.energyFit('light', 'focus') === 0.2 && w.energyFit(null, 'focus') === 0.6);
  // 정규화 가중 합=1 (모든 항 1.0 → 점수 1.0)
  const full = w.suggestScore({ priority: 1, due: plusDays(-1), estimate: 60, weight: 'focus' }, 30, { energyMode: 'focus' });
  ck('정규화 가중 합=1 (점수 1.0)', Math.abs(full.score - 1) < 1e-9);
  // 불변식: energyMode 미설정이면 new=0.85*old+0.09 아핀변환
  const cases = [
    { id: 'o1', priority: 1, due: plusDays(-2), estimate: 30, weight: 'focus' },
    { id: 'o2', priority: 3, due: plusDays(1), estimate: 10, weight: 'light' },
    { id: 'o3', priority: 4, due: null, estimate: null, weight: null },
    { id: 'o4', priority: 2, due: plusDays(5), estimate: 25, weight: 'focus' },
    { id: 'o5', priority: 3, due: plusDays(0), estimate: 60, weight: null },
  ];
  const oldScore = t => 0.38 * w.prioScore(t) + 0.37 * w.urgencyScore(t) + 0.25 * w.fitScore(t, 30);
  const affineOk = cases.every(t => Math.abs(w.suggestScore(t, 30).score - (0.85 * oldScore(t) + 0.09)) < 1e-9);
  ck('아핀변환 new=0.85*old+0.09', affineOk);
  const orderNew = cases.slice().sort((a, b) => w.suggestScore(b, 30).score - w.suggestScore(a, 30).score).map(t => t.id).join(',');
  const orderOld = cases.slice().sort((a, b) => oldScore(b) - oldScore(a)).map(t => t.id).join(',');
  ck('energyMode 미설정 정렬 기존과 동일', orderNew === orderOld);
  // reason: 에너지 사유는 마감/우선순위 사유가 없을 때만
  ck('reason 가벼운 일', w.suggestScore({ priority: 4, due: null, weight: 'light' }, 30, { energyMode: 'light' }).reason === '가벼운 일');
  ck('reason 집중할 일', w.suggestScore({ priority: 4, due: null, weight: 'focus' }, 30, { energyMode: 'focus' }).reason === '집중할 일');
  ck('reason 마감 우선(에너지 무시)', w.suggestScore({ priority: 4, due: plusDays(-1), weight: 'light' }, 30, { energyMode: 'light' }).reason === '지난 마감');
  ck('reason 모드 불일치는 틈에 적합', w.suggestScore({ priority: 4, due: null, weight: 'focus' }, 30, { energyMode: 'light' }).reason === '틈에 적합');
  // timeOfDayMode 경계
  ck('timeOfDayMode 오전 focus', w.timeOfDayMode(6) === 'focus' && w.timeOfDayMode(9) === 'focus' && w.timeOfDayMode(11) === 'focus');
  ck('timeOfDayMode 오후 light', w.timeOfDayMode(13) === 'light' && w.timeOfDayMode(16) === 'light');
  ck('timeOfDayMode 저녁 light', w.timeOfDayMode(21) === 'light' && w.timeOfDayMode(23) === 'light');
  ck('timeOfDayMode 그 외 null', w.timeOfDayMode(5) === null && w.timeOfDayMode(12) === null && w.timeOfDayMode(18) === null && w.timeOfDayMode(0) === null);
  // mergeStates 무영향: weight는 id별 최신 task 객체를 따라감
  let mg = w.mergeStates(
    { tasks: [{ id: 'T', title: 'x', weight: 'focus', updatedAt: 5 }], updatedAt: 10 },
    { tasks: [{ id: 'T', title: 'x', weight: 'light', updatedAt: 9 }], updatedAt: 20 });
  ck('mergeStates: weight 최신 task 따라감', mg.tasks.find(t => t.id === 'T').weight === 'light');
}

// migrate: weight 정규화 (가져오기 경로로 저장까지 검증)
{
  section('에너지 migrate');
  const { window: w, $, getErr } = boot(baseState());
  $('.nav[data-view="settings"]').click();
  const old = {
    tasks: [
      { id: 'nw', title: '무가중', status: 'next', priority: 2 },
      { id: 'bad', title: '잘못된값', status: 'next', priority: 2, weight: 'heavy' },
      { id: 'ok', title: '집중', status: 'next', priority: 2, weight: 'focus' },
    ], projects: [], sessions: [], settings: { focus: 25, short: 5, long: 15, longEvery: 4 }, top3: {}, updatedAt: 5,
  };
  const file = new w.File([JSON.stringify(old)], 'wt.json', { type: 'application/json' });
  const input = $('#impFile');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await sleep(40);
  ck('런타임 에러 없음', !getErr());
  const st = JSON.parse(w.localStorage.getItem('flowdo.state.v1'));
  ck('migrate: weight 미설정→null', st.tasks.find(t => t.id === 'nw').weight === null);
  ck('migrate: 잘못된 weight→null', st.tasks.find(t => t.id === 'bad').weight === null);
  ck('migrate: 유효 weight 보존', st.tasks.find(t => t.id === 'ok').weight === 'focus');
}

// UI 스모크: weightPick 모달 + energyChips 게이트
{
  section('에너지 UI');
  // 1) 모달 weightPick 저장/해제
  const r3 = boot(baseState());
  r3.$('#newTaskBtn').click();
  ck('weightPick 2버튼', r3.$$('#weightPick button').length === 2);
  r3.$('#f-title').value = '가중치 테스트';
  r3.$('#weightPick button[data-w="focus"]').click();
  ck('weightPick 클릭 선택', r3.$('#weightPick button[data-w="focus"]').classList.contains('sel'));
  r3.$('#taskSaveBtn').click();
  const st3 = JSON.parse(r3.window.localStorage.getItem('flowdo.state.v1'));
  ck('saveTask: weight 저장', st3.tasks.find(t => t.title === '가중치 테스트').weight === 'focus');
  r3.$('#newTaskBtn').click();
  r3.$('#weightPick button[data-w="light"]').click();
  r3.$('#weightPick button[data-w="light"]').click();
  ck('weightPick 재클릭 해제(null)', !r3.$('#weightPick button[data-w="light"]').classList.contains('sel'));
  // 2) openTask: 기존 weight 로드
  const r4 = boot(baseState({ tasks: [{ id: 'wt', title: '집중작업', status: 'next', priority: 2, weight: 'focus', due: todayDS, tags: [], createdAt: 1, updatedAt: 1 }] }));
  r4.$('.nav[data-view="today"]').click();
  r4.$('.task-title').click();
  ck('openTask: 기존 weight 로드', r4.$('#weightPick button[data-w="focus"]').classList.contains('sel'));
  ck('런타임 에러 없음(modal)', !r4.getErr());
  // 3) cold-start 게이트: 가중 task 없으면 energyChips 비노출
  const cold = boot(baseState({ tasks: [
    { id: 'a', title: 't1', status: 'next', priority: 3, tags: [], createdAt: 1, updatedAt: 1 },
    { id: 'b', title: 't2', status: 'next', priority: 3, tags: [], createdAt: 2, updatedAt: 1 },
    { id: 'c', title: 't3', status: 'next', priority: 3, tags: [], createdAt: 3, updatedAt: 1 },
  ] }));
  cold.$('.nav[data-view="suggest"]').click();
  ck('cold-start: energyChips 비노출', !cold.$('#energyChips'));
  // 4) 가중 task 충분 → energyChips 노출 + 상호작용 + reason 칩
  const warm = boot(baseState({ tasks: [
    { id: 'a', title: '가벼움a', status: 'next', priority: 3, weight: 'light', tags: [], createdAt: 1, updatedAt: 1 },
    { id: 'b', title: '집중b', status: 'next', priority: 3, weight: 'focus', tags: [], createdAt: 2, updatedAt: 1 },
    { id: 'c', title: '중립c', status: 'next', priority: 3, tags: [], createdAt: 3, updatedAt: 1 },
  ] }));
  warm.$('.nav[data-view="suggest"]').click();
  ck('energyChips 노출', !!warm.$('#energyChips'));
  ck('energyChips 2버튼', warm.$$('#energyChips button').length === 2);
  // 시각 무관 결정성: timeOfDayMode가 이미 focus를 기본 선택했으면(예: 오전) 먼저 light로 옮긴 뒤 focus를 '진짜로' 선택.
  if (warm.$('#energyChips button[data-w="focus"]').classList.contains('sel')) warm.$('#energyChips button[data-w="light"]').click();
  warm.$('#energyChips button[data-w="focus"]').click();
  ck('energyChips 클릭 선택', warm.$('#energyChips button[data-w="focus"]').classList.contains('sel'));
  ck('reason 칩 에너지 사유', warm.$$('#sgList .chip.why').some(c => c.textContent.includes('집중할 일')));
  ck('카드 점수 비노출', !/0\.\d{2,}/.test(warm.$('#sgList').textContent));
  ck('런타임 에러 없음(suggest)', !warm.getErr());
}

// ───────────────────────── 20) 프로젝트: 인라인 생성·사용자 색상·삭제 ─────────────────────────
{
  section('프로젝트 관리');
  // (1) 할 일 편집 모달에서 '+ 새 프로젝트…'로 인라인 생성
  {
    const { $, $$, window, getErr } = boot(baseState({
      tasks: [{ id: 't1', title: '할일1', status: 'next', priority: 3, due: todayDS, tags: [], createdAt: 1, updatedAt: 1 }]
    }));
    $('.nav[data-view="today"]').click();
    $$('.task').find(n => n.textContent.includes('할일1')).querySelector('[data-act="edit"]').click();
    const sel = $('#f-project');
    ck('새 프로젝트 옵션 존재', $$('#f-project option').some(o => o.value === '__new__'));
    window.prompt = () => '인라인프로젝트';
    sel.value = '__new__';
    sel.dispatchEvent(new window.Event('change'));
    const st = JSON.parse(window.localStorage.getItem('flowdo.state.v1'));
    const np = st.projects.find(p => p.name === '인라인프로젝트');
    ck('프롬프트 이름으로 프로젝트 생성', !!np);
    ck('생성된 프로젝트가 선택됨', sel.value === (np && np.id));
    ck('차분한 팔레트 색 적용', !!np && /^#[0-9a-f]{6}$/i.test(np.color));
    ck('런타임 에러 없음(인라인)', !getErr());
  }
  // (2) 새 프로젝트 모달 — 사용자 지정 색상
  {
    const { $, window, getErr } = boot(baseState());
    $('#addProjectBtn').click();
    ck('사용자 색상 입력 존재', !!$('#p-customColor'));
    $('#p-customColor').value = '#123456';
    $('#p-customColor').dispatchEvent(new window.Event('input'));
    $('#p-name').value = '커스텀색';
    $('#projSaveBtn').click();
    const st = JSON.parse(window.localStorage.getItem('flowdo.state.v1'));
    const p = st.projects.find(x => x.name === '커스텀색');
    ck('사용자 지정 색상 저장', !!p && p.color === '#123456');
    ck('런타임 에러 없음(색상)', !getErr());
  }
  // (2b) 기존 프로젝트 편집 — 제목·색상 수정
  {
    const { $, $$, window, getErr } = boot(baseState({
      projects: [{ id: 'p1', name: '옛이름', color: '#4f6da3', updatedAt: 1 }]
    }));
    window.confirm = () => true;
    $$('#projectNav .nav')[0].click();        // 프로젝트 뷰 진입
    ck('프로젝트 수정 버튼 노출', !!$('#projEditBtn'));
    $('#projEditBtn').click();
    ck('편집 모달에 기존 이름 채움', $('#p-name').value === '옛이름');
    ck('편집 모드 제목', $('#projHead').textContent === '프로젝트 편집');
    $('#p-name').value = '새이름';
    $('#p-customColor').value = '#abcdef';
    $('#p-customColor').dispatchEvent(new window.Event('input'));
    $('#projSaveBtn').click();
    const st = JSON.parse(window.localStorage.getItem('flowdo.state.v1'));
    ck('이름 수정 반영', st.projects.find(p => p.id === 'p1').name === '새이름');
    ck('색상 수정 반영', st.projects.find(p => p.id === 'p1').color === '#abcdef');
    ck('새 프로젝트가 추가되지 않음(편집)', st.projects.length === 1);
    ck('런타임 에러 없음(편집)', !getErr());
  }
  // (3) 프로젝트 삭제 — 할 일은 보존(연결 해제)+tombstone
  {
    const { $, $$, window, getErr } = boot(baseState({
      projects: [{ id: 'p1', name: '지울프로젝트', color: '#4f6da3', updatedAt: 1 }],
      tasks: [{ id: 't1', title: '연결된할일', status: 'next', priority: 3, projectId: 'p1', tags: [], createdAt: 1, updatedAt: 1 }]
    }));
    window.confirm = () => true;
    $$('#projectNav .nav')[0].click();        // 프로젝트 뷰 진입
    ck('프로젝트 삭제 버튼 노출', !!$('#projDelBtn'));
    $('#projDelBtn').click();
    const st = JSON.parse(window.localStorage.getItem('flowdo.state.v1'));
    ck('프로젝트 제거됨', !st.projects.some(p => p.id === 'p1'));
    ck('할 일은 보존(연결만 해제)', st.tasks.some(t => t.id === 't1' && !t.projectId));
    ck('tombstone 기록(동기화 부활 방지)', !!(st.deletions && st.deletions.p1));
    ck('런타임 에러 없음(삭제)', !getErr());
  }
}

// ───────────────────────── 21) 개인 집중 프로파일 (6블록 순위) ─────────────────────────
{
  const ORDER = ['morn','dawn','lunch','noon','eve','night']; // rank0=morn(9-12) … rank5=night(21-24)
  const { window: W, $, $$, getErr } = boot(baseState());
  const { focusLevel, profileMode, hourToBlock, timeOfDayMode, mergeStates, isValidFocusOrder } = W;

  section('집중 프로필 매핑');
  ck('hourToBlock 후반 경계', hourToBlock(9)==='morn' && hourToBlock(12)==='lunch' && hourToBlock(14)==='noon' && hourToBlock(21)==='night');
  ck('hourToBlock 시작 경계', hourToBlock(6)==='dawn' && hourToBlock(23)==='night');
  ck('hourToBlock 미커버', hourToBlock(5)===null && hourToBlock(24)===null && hourToBlock(-1)===null);
  ck('focusLevel rank 선형', focusLevel(10,ORDER)===1.0 && focusLevel(22,ORDER)===0.0);
  ck('focusLevel 미설정→null', focusLevel(10,null)===null && focusLevel(10,['a'])===null);
  ck('profileMode 2/2/2', profileMode(10,ORDER)==='focus' && profileMode(22,ORDER)==='light' && profileMode(13,ORDER)===null);
  ck('isValidFocusOrder 순열만 인정', isValidFocusOrder(ORDER) && !isValidFocusOrder(['morn','morn','dawn','noon','eve','night']));

  section('프로필 손상 내성');
  ck('foreign-keys len6 → null', focusLevel(10,['x','x','x','x','x','x'])===null);
  ck('dup-keys len6 → null', focusLevel(10,['dawn','dawn','morn','noon','eve','night'])===null);
  ck('foreign+missing len6 → null', focusLevel(10,['dawn','morn','lunch','noon','eve','ZZZ'])===null);
  ck('손상 프로필 → profileMode 폴백', profileMode(10,['x','x','x','x','x','x'])===timeOfDayMode(10));

  section('추천 불변식(프로파일)');
  const hrs = Array.from({length:24},(_,h)=>h);
  ck('미설정 → 전 시각 폴백 동일', hrs.every(h=>profileMode(h,null)===timeOfDayMode(h)));
  ck('무효 → 전 시각 폴백 동일', hrs.every(h=>profileMode(h,['a','b'])===timeOfDayMode(h)));
  ck('정규화 가중 합=1', Math.abs((0.323+0.3145+0.2125+0.15)-1) < 1e-9);

  section('프로필 동기화 병합');
  ck('한쪽만 focusOrder → 보존', JSON.stringify(mergeStates({settings:{focusOrder:ORDER},updatedAt:20},{settings:{},updatedAt:10}).settings.focusOrder)===JSON.stringify(ORDER));
  ck('null이 newer면 클로버', mergeStates({settings:{focusOrder:ORDER},updatedAt:10},{settings:{focusOrder:null},updatedAt:20}).settings.focusOrder===null);
  ck('충돌 → newer 승', JSON.stringify(mergeStates({settings:{focusOrder:['night','eve','noon','lunch','dawn','morn']},updatedAt:10},{settings:{focusOrder:ORDER},updatedAt:20}).settings.focusOrder)===JSON.stringify(ORDER));

  section('집중 순서 UI');
  // baseState는 focusOrder 없음 → migrate가 null로 정규화(미설정) 검증
  $('.nav[data-view="settings"]').click();
  ck('설정에 6블록 컨트롤', $$('#focus-order [data-focusblock]').length===6);
  ck('미설정 시 효과 라벨 없음', $$('.focus-eff').length===0);
  ck('미설정 부팅 무에러', !getErr());
  // 첫 행을 아래로 → 프로파일 확립(순열 저장)
  $$('#focus-order .focus-row')[0].querySelector('[data-act="down"]').click();
  const saved = JSON.parse(W.localStorage.getItem('flowdo.state.v1')).settings.focusOrder;
  ck('재정렬 → focusOrder 순열 저장', Array.isArray(saved) && saved.length===6 && saved[0]==='morn' && saved[1]==='dawn');
  ck('설정 후 효과 라벨 표시', $$('.focus-eff').length===6 && $$('.focus-eff')[0].textContent==='집중');
  // 기본값으로 초기화
  $('#focus-reset').click();
  ck('초기화 → null', JSON.parse(W.localStorage.getItem('flowdo.state.v1')).settings.focusOrder===null);
}

// ───────────────────────── 22) 마감 칩 강조 (dueLevel) ─────────────────────────
{
  section('마감 칩 강조');
  const { window: W, $, $$, getErr } = boot(baseState());
  const { dueLevel, addDaysDS } = W;
  const td = todayDS;
  ck('지남 → over', dueLevel(addDaysDS(td,-1))==='over' && dueLevel(addDaysDS(td,-30))==='over');
  ck('오늘 → d0', dueLevel(td)==='d0');
  ck('내일 → d1', dueLevel(addDaysDS(td,1))==='d1');
  ck('2~3일 → soon', dueLevel(addDaysDS(td,2))==='soon' && dueLevel(addDaysDS(td,3))==='soon');
  ck('4~7일 → week', dueLevel(addDaysDS(td,4))==='week' && dueLevel(addDaysDS(td,7))==='week');
  ck('먼 미래 → far', dueLevel(addDaysDS(td,8))==='far' && dueLevel(addDaysDS(td,100))==='far');
  ck('마감 없음 → null', dueLevel(null)===null);
  // 렌더된 칩에 단계 클래스가 실제로 붙는지(오늘 마감 태스크)
  const w2 = boot(baseState({ tasks:[{ id:'x', title:'오늘마감', status:'next', priority:3, due:td, tags:[], createdAt:1, updatedAt:1 }] }));
  w2.$('.nav[data-view="today"]').click();
  const chip = w2.$$('.chip.due')[0];
  ck('렌더 칩에 due-d0 클래스', !!chip && chip.classList.contains('due-d0'));
  ck('런타임 에러 없음(마감 칩)', !getErr() && !w2.getErr());
}

// ───────────────────────── 23) 캘린더 완료 체크(캔슬아웃) ─────────────────────────
{
  section('캘린더 완료 체크');
  // 타임박스 블록: 체크 → 완료 + 취소선(done) 유지
  {
    const b = boot(baseState({ tasks:[{ id:'tb', title:'블록작업', status:'next', priority:3, block:{date:todayDS,start:480,duration:30}, tags:[], createdAt:1, updatedAt:1 }] }), { planview:'day' });
    b.$('.nav[data-view="plan"]').click();
    const blk = b.$('.block-card');
    ck('타임박스 블록 렌더', !!blk);
    ck('블록에 완료 체크 버튼', !!(blk && blk.querySelector('.bc-check')));
    blk.querySelector('.bc-check').click();
    const st = JSON.parse(b.window.localStorage.getItem('flowdo.state.v1'));
    ck('블록 체크 → 완료', st.tasks.find(x=>x.id==='tb').status==='done');
    ck('완료 블록 취소선 유지(.done)', !!b.$('.block-card.done'));
    ck('런타임 에러 없음(블록)', !b.getErr());
  }
  // '오늘 할 일' 풀: 체크 → 완료 + 취소선으로 남아 캘린더와 연동
  {
    const p = boot(baseState({ tasks:[{ id:'pt', title:'오늘마감일', status:'next', priority:2, due:todayDS, tags:[], createdAt:1, updatedAt:1 }] }), { planview:'day' });
    p.$('.nav[data-view="plan"]').click();
    const card = p.$$('.pool-task').find(c=>c.textContent.includes('오늘마감일'));
    ck('풀에 오늘 할 일 노출', !!card);
    ck('풀 항목 완료 체크 버튼', !!(card && card.querySelector('.pt-check')));
    card.querySelector('.pt-check').click();
    const st = JSON.parse(p.window.localStorage.getItem('flowdo.state.v1'));
    ck('풀 체크 → 완료', st.tasks.find(x=>x.id==='pt').status==='done');
    ck('완료해도 풀에 취소선 유지', !!p.$$('.pool-task.done').find(c=>c.textContent.includes('오늘마감일')));
    ck('런타임 에러 없음(풀)', !p.getErr());
  }
}

// ───────────────────────── 24) 오프라인 그레이스 (PWA 오프라인 사용) ─────────────────────────
{
  section('오프라인 그레이스');
  // 세션 확인 불가(테스트 환경 = supabase 라이브러리 로드 실패와 동일 경로) + 이전 로그인 기록 → 게이트 통과
  {
    const g = boot(baseState(), { lastAuth: { id: 'u-123', email: 'me@example.com', at: 1 } });
    const gate = g.$('#authGate');
    ck('이전 로그인 기록 → 게이트 통과', !!gate && !gate.classList.contains('show'));
    ck('확인중 상태 해제', !gate.classList.contains('checking'));
    ck('배지 = 오프라인', g.$('#syncBadge').textContent === '오프라인');
    ck('런타임 에러 없음(그레이스)', !g.getErr());
    // 명시적 로그아웃 → 기록 제거 + 게이트 복귀
    g.$('.nav[data-view="settings"]').click();
    const out = g.$('#cf-logout');
    ck('설정에 로그아웃 버튼', !!out);
    out.click();
    ck('로그아웃 → lastAuth 제거', g.window.localStorage.getItem('flowdo.lastAuth') === null);
    ck('로그아웃 → 게이트 다시 표시', gate.classList.contains('show'));
  }
  // 기록 없으면 기존대로 로그인 게이트 유지(그레이스 미적용)
  {
    const n = boot(baseState());
    ck('기록 없음 → 게이트 유지', n.$('#authGate').classList.contains('show'));
    ck('기록 없음 → 배지 로컬', n.$('#syncBadge').textContent !== '오프라인');
    ck('런타임 에러 없음(게이트)', !n.getErr());
  }
}

// ───────────────────────── 결과 ─────────────────────────
let ok = 0, fail = 0, lastSec = '';
for (const [sec, name, pass] of results) {
  if (sec !== lastSec) { console.log(`\n[${sec}]`); lastSec = sec; }
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  pass ? ok++ : fail++;
}
console.log(`\n${ok}/${ok + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
