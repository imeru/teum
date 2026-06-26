// 틈(TEUM) 헤드리스 회귀 테스트 — jsdom으로 index.html+app.js를 평가해 DOM 동작을 검증.
// 실행: npm test  (사전: npm install)
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

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
    ]
  }));
  $('.nav[data-view="suggest"]').click();
  ck('런타임 에러 없음', !getErr());
  let titles = $$('.sg-title').map(x => x.textContent);
  ck('15분: 소요>틈/언젠가 제외', !titles.includes('큰일55분') && !titles.includes('안맞는2시간') && !titles.includes('언젠가'));
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
  ck('settings.notify 보강', st.settings.notify === false);
  ck('데이터 반영', st.tasks[0].title === '옛할일');
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
