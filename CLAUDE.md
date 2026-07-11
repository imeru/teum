# 틈 (TEUM) 프로젝트 안내 (Claude / Claude Code용)

> **모든 틈을 의미 있는 진전으로. (Turn every gap into meaningful progress.)**

브랜드명 **틈 (TEUM)**. GTD, 타임블로킹, 뽀모도로, 캘린더를 결합해 "지금 가진 틈으로 무엇을 해낼 수 있는가"를 돕는 **의도적 시간관리 PWA**.
빌드 도구·프레임워크 없는 바닐라 JS 단일 페이지 앱. GitHub Pages로 배포하며 Supabase(Google 로그인)로 기기 간 동기화한다.
(코드 곳곳의 `flowdo` 명칭은 리브랜딩 전 이름의 레거시다. 데이터 호환을 위해 유지한다. 아래 하드 룰 참조.)

## ⚠️ 항상 먼저 참고할 제품 설계 문서 세트 (`docs/`)
모든 기능 추가·수정·디자인 결정 전에 아래 문서를 **반드시 참고**하고 그 원칙에 맞춰 작업한다. 충돌 시 이 문서들이 기준이다.

- `docs/BRAND.md` 브랜드 철학·미션·태그라인·제품 비전
- `docs/PRODUCT_PRINCIPLES.md` 핵심 원칙(시간이 작업보다 먼저), 일일 워크플로(Capture→Clarify→Estimate→Schedule→Focus→Complete→Reflect)
- `docs/FEATURE_PHILOSOPHY.md` 무엇을 만들고 만들지 않는가(Must/Nice/Avoid)
- `docs/FEATURE_SPEC.md` Inbox/Today/Time Slots/Smart Suggestion/Focus Mode/Daily Review 사양
- `docs/DESIGN_LANGUAGE.md` 차분·여백·미니멀, 색 의미, 정보 위계
- `docs/AI_PRINCIPLES.md` "AI는 추천, 결정은 사람." 해도 되는 것/절대 안 되는 것
- `docs/PRODUCT_ROADMAP.md` Phase 1~3 및 장기 비전
- `docs/USER_PERSONAS.md` 지식노동자·대학원생·바쁜 부모·창작자

## 기능 판단 기준 (새 기능을 만들기 전 자문)
1. 틈(짜투리 시간) 활용을 돕는가?  2. 인지 부하를 줄이는가?  3. 집중을 돕는가?
4. 인터페이스를 더 단순하게 하는가?  5. 새 사용자가 즉시 이해하는가?
→ 아니면 만들지 않는다. **의심스러우면 더하지 말고 덜어낸다.** 명료함·집중·차분함이 곧 기능.
배제가 확정된 것: 통계 대시보드·생산성 점수(수치 강박 금지), 협업/공유, ML 자동 학습, 자가평가 슬라이더.

## 하드 룰 (어기면 앱이나 데이터가 깨진다)
1. **무빌드·무프레임워크 유지.** npm 의존성은 테스트용(jsdom)뿐이다. 번들러·트랜스파일러·프레임워크를 도입하지 않는다.
2. **ES 모듈 금지.** `import`/`export`를 쓰는 순간 eval 기반 테스트 하네스와 file:// 실행이 깨진다. 모든 스크립트는 전역 공유 클래식 스크립트다.
3. **스크립트 로드 순서 고정**: `supabase.js → constants.js → helpers.js → logic.js → vendor/quill.js → app.js` (index.html 하단). 새 전역은 이 순서 안에서만 참조 가능하다.
4. **`flowdo.*` 키와 Supabase 테이블명 `flowdo`를 바꾸지 않는다.** 바꾸면 기존 사용자 데이터가 유실된다.
5. **Supabase `updated_at` 컬럼은 timestamptz다. ISO 문자열로 보낸다.** 밀리초 숫자를 보내면 upsert가 조용히 전부 실패한다(과거 동기화 전체 마비의 원인).
6. **CSP가 `script-src 'self'`다(index.html meta).** 외부 CDN 스크립트·스타일을 추가하지 않는다. 라이브러리가 필요하면 `vendor/`에 파일로 넣고 CSP·SW 캐시 목록을 갱신한다.
7. **순수 함수는 `logic.js`(도메인)·`helpers.js`(범용)에, DOM·상태·이벤트는 `app.js`(단일 IIFE)에 둔다.** logic/helpers는 DOM에 의존하면 안 된다(테스트가 직접 호출).
8. **상태 변경 후 항상 `save()` → `render()`(또는 해당 뷰의 renderX).** save()가 로컬 저장과 동기화 예약을 함께 한다.
9. **UI 텍스트는 한국어.** 색은 의미를 전달할 때만 쓴다: 초록=진전/완료, 파랑(`--focus`)=집중, 앰버=주의/마감 임박, 빨강=지연·오류만.
10. **추천 순위 불변식.** 에너지 모드·집중 프로파일을 사용자가 설정하지 않았다면 '지금 이 틈' 추천 순위는 그 기능들이 없던 시절과 완전히 같아야 한다. suggestScore를 수정할 때 이 계약을 테스트로 보장한다.

## 완료의 정의 (모든 코드 변경은 이 체크를 통과해야 끝난 것)
1. `node --check app.js logic.js helpers.js constants.js service-worker.js` 통과.
2. `npm test` 전부 통과(현재 439개). **새 동작에는 테스트를 추가**하고, 기존 테스트를 약화시키지 않는다.
3. **사용자에게 보이는 변경이면 `service-worker.js`의 `CACHE = 'teum-vNN'`을 +1.** 안 올리면 배포해도 기존 사용자에게 반영되지 않는다.
4. 커밋 접두사 `feat: fix: refactor: docs: test: style: chore:` + 본문에 무엇을·왜. push 후 **GitHub Actions CI가 green인 것까지 확인**해야 완료다(`gh run list`).
5. 테스트는 결정적이어야 한다: 시각·시간대 의존 금지(CI는 UTC, 로컬은 KST에서 모두 통과), `Date.now()` 기반 기본값이 끼어드는 UI는 상태를 명시해 고정한다.

## 파일 구성
- `index.html` UI 마크업, CSP meta, SVG 아이콘 스프라이트(`i-*` symbol), 로그인 게이트, 모달(할 일/프로젝트/일정/동의).
- `styles.css` 전체 스타일(라이트/다크는 `prefers-color-scheme`). 디자인 토큰은 `:root` CSS 변수.
- `app.js` (~2800줄) 앱 로직 단일 IIFE: 상태·마이그레이션·렌더·드래그·동기화·알림·보관함.
- `logic.js` 순수 도메인 로직: 추천 점수(suggestScore/energyFit/profileMode 등), 병합(mergeStates), 반복(nextRepeatDate), 보관 분리(splitArchive), 겹침 레인(assignLanes), 타임박스 수학(tb*).
- `helpers.js` 범용 헬퍼: `$, el, esc, pad, todayStr, parseDS, addDaysDS, addMonthsDS, fmtDue, isDone, hhmmToMin` 등.
- `constants.js` `PROJECT_COLORS, DOW, KR_HOLIDAYS(연도별)·KR_HOLIDAYS_FIXED·KR_HOLIDAY_NAMES, CAL_END/SNAP_MIN/PX_PER_MIN, MEMO_COLORS`.
- `supabase.js` supabase-js UMD 번들(CDN 대신 로컬). `vendor/` Quill 에디터 번들.
- `service-worker.js` 오프라인 캐시(cache-first, 같은 출처만). `manifest.json`, `icons/` PWA.
- `privacy.html` 개인정보처리방침. `_headers` 보안 헤더(Netlify형식, GitHub Pages에서는 무시됨).
- `tests/run.mjs` 헤드리스 테스트(jsdom). `.github/workflows/ci.yml` push마다 문법 검사+전체 테스트.
- `docs/` 제품 설계 문서 세트(최상단 참조). `README.md` 배포·Supabase·Google 로그인 설정(RLS SQL 포함).
- `HANDOFF.md` 초기 인수인계 문서(낡음). 충돌 시 이 파일(CLAUDE.md)이 우선한다.

## 실행 / 테스트
- 실행: `index.html`을 브라우저로 열면 됨(로컬 저장). PWA·로그인·동기화는 HTTPS 호스팅 필요.
- 테스트: `npm install`(최초 1회, jsdom) 후 `npm test`.
- 테스트 하네스 규약(tests/run.mjs): `boot(baseState({...}), opts)`로 앱 전체를 jsdom에 부팅. opts: `planview, lastview, firstRun, notify, lastAuth`. 단언은 `section('이름')` + `ck('설명', 조건)`. 순수 함수는 `boot().window.함수명`으로 직접 호출.
- 픽스처 제목은 부분 문자열 충돌을 피한다(예: '삼십분블록'은 '십분블록'을 포함해 textContent 검색이 엉킨다).

## 데이터 모델 (localStorage `flowdo.state.v1`, 서버 행 `u_<userId>`의 data jsonb)
- `tasks[]`: `{id,title,notes,status,priority(1~4),tags[],projectId,due,dueTime,repeat,weight,estimate,subtasks[],block,createdAt,updatedAt,completedAt}`
  - `status`: `inbox | next | waiting | someday | done` (GTD). **'오늘'은 상태가 아니라 `due`가 오늘인 것.** 오늘로 보내는 조작(드롭·원탭 버튼)은 `due=오늘 + status='next'` 승격으로 통일되어 있다.
  - `repeat`: `'daily'|'weekly'|'monthly'|null`. 완료 시 다음 회차 자동 생성(`nextRepeatDate`, 말일 클램프).
  - `weight`: `'light'|'focus'|null` 에너지/집중도. `estimate`: 예상 소요(분). `subtasks[]`: `{id,title,done}` 체크리스트.
  - `block`: `{date,start(분),duration(분)}` 타임박스 배치. `_prev`: 완료 해제 시 복원용 내부 필드.
- `projects[]`: `{id,name,color,updatedAt}` (색상 팔레트+사용자 지정, 생성 후 편집 가능)
- `events[]`: 일정. 정기(`freq: weekly|monthly`, `monthMode: date|weekday`, `endMode: never|date|count`, `excludeHolidays`)와 일반(`freq:'once'`, `allDay`, `startDate~endDate` 멀티데이 배너) 모두 포함.
- `sessions[]`: 뽀모도로 기록 `{id,taskId,date,duration,at}`. `memos[]`/`folders[]`: 메모(Quill html)·폴더, 휴지통은 `trashedAt`.
- `settings`: `{focus,short,long,longEvery}`(뽀모도로 분) + `notify,notifyLead`(포그라운드 알림) + `focusOrder`(집중 프로파일: 6블록 키 순열|null. 미설정/무효면 timeOfDayMode 폴백 → 추천 불변) + `keepMonths`(완료 보관 기준 개월, 0=끄기, 기본 6)
- `top3`: `{'YYYY-MM-DD':[taskId×3]}`. `weekNotes`: 주간 리뷰 메모. `holidays[]`: 사용자 추가 휴무일(국경일은 KR_HOLIDAY_NAMES로 자동).
- `deletions`: `{id: deletedAt}` **tombstone. 삭제·보관의 동기화 전파에 필수라 임의로 비우면 안 된다**(12개월 지난 항목은 자동 정리).
- `migrate()`가 부팅·가져오기·pull 모든 경로에서 누락 필드를 보강한다. 새 필드를 추가하면 migrate 한 줄도 함께 추가한다.
- 기타 localStorage 키: `flowdo.cloud.v1`(연결 정보), `flowdo.archive.v1`(보관함), `flowdo.planview`(일/주/월), `flowdo.lastview`(마지막 화면 복원), `flowdo.guideSeen`, `flowdo.privacyConsent`, `flowdo.lastAuth`(오프라인 그레이스), `flowdo.lastSnap`(스냅샷 시각).

## 주요 화면 (사이드바 순서대로, 마지막 화면이 홈으로 복원됨)
- **타임박스(plan)**: 좌측 미니월달력+TOP3+할 일 풀('오늘 할 일'/'다음 할 일 (GTD)', 그룹 개수는 미완료만)+일정 목록, 우측 일간/주간/월간 캘린더.
  - 일간: 06~24시(기본 08시 시작, 새벽 접기), 10분 스냅, 1분=1px. 드래그 배치·이동·길이 조절, 완료 체크(취소선), 겹침은 나란히(assignLanes), 40분 이하 블록은 한 줄(compact)·20분 이하는 제목만(tiny). 주간: 요일별 세로 캘린더. 월간: 종일·멀티데이 배너, 공휴일 이름 표시(다년 자동).
- **오늘 할 일(today)**: 오늘 마감·지남·오늘 배치된 할 일 목록.
- **지금 이 틈(suggest)**: 가용 시간 선택 → 추천. 에너지 칩(가벼운 일|집중할 일, 시간대·집중 프로파일이 기본값 제안, cold-start 게이트로 무게 미보급 시 숨김).
- **GTD 보드(gtdboard)**: 4열 칸반 Inbox|다음 할일|대기중 (위임)|언젠가. 열별 빠른 추가, 드래그 이동, 카드 원탭 '오늘' 버튼(모바일 대안).
- **뽀모도로(pomodoro)**: 타이머(뷰 이동에도 유지), 세션 기록.
- **메모(memo)**: Quill 에디터, 폴더·고정·휴지통, 카드 목록.
- **검색(search)**: 할 일+메모 통합 검색, 범위 칩(전체|할 일|메모).
- **완료(done)**: 완료일 기준 날짜별 그룹(오늘/어제/M월 D일). **이 뷰만 completedAt 내림차순**, 나머지는 sortTasks.
- **일일 리뷰(review)·주간 리뷰(weekreview)·사용 가이드(guide, 첫 실행 자동)·설정(settings)**: 계정, PWA 설치, 알림, 집중 시간대 순서(▲/▼ 6블록), 휴무일, 데이터 정리·자동 백업(보관함·스냅샷 복원), JSON 백업/복원, 중복 정리.

## 드래그앤드롭 / 완료·삭제 규칙
- 카드류는 `dataTransfer`에 task id를 싣는다. 드롭 대상: 캘린더(배치), TOP3, 주간 날짜 셀(마감 변경), 좌측 풀(배치 해제), 사이드바 항목(`makeNavDrop` 상태/프로젝트/태그 변경. '오늘 할 일' 드롭은 due=오늘+next 승격).
- HTML5 드래그는 터치에서 동작하지 않는다. 모바일 동선(원탭 버튼·편집 모달)을 항상 함께 고려한다.
- 완료·삭제는 `toast(msg, undoFn)`로 **실행 취소**를 제공한다(삭제는 tombstone 복원, 반복 완료는 생성 회차 회수 포함).

## 클라우드 동기화 (수정 시 신중, 테스트 필수)
- 로그인 필수(Google OAuth). 단 **오프라인 그레이스**: 이 기기에서 로그인했던 사용자는 오프라인/서버 접속 불가 시 통과(`flowdo.lastAuth`, 배지 '오프라인', 복귀 시 자동 세션 복구).
- 병합은 `mergeStates`(logic.js): tasks/memos/folders/projects/events는 **id별 updatedAt 최신 우선 + tombstone**, sessions/holidays는 합집합, settings/top3/weekNotes는 키별 병합(충돌 시 상태 updatedAt 최신 쪽). 같은 항목 충돌은 필드 병합이 아니라 최신 객체 전체 승리다.
- pull은 내용 시그니처(sigOf)로 게이트, 로컬 기여가 있으면 병합본을 다시 push(수렴). 트리거: 실시간 구독(내 행 변경), 포커스/가시성/온라인 복귀, 45초 폴링. 편집·모달 중(`syncBusy`)에는 보류.
- 서버: 테이블 `flowdo`(id text PK, data jsonb, updated_at timestamptz). RLS "own rows" 정책 적용됨(본 행 `u_<uid>` + 접미사 행 허용, README SQL). 보관함 `u_<uid>:arc`, 주간 스냅샷 `u_<uid>:snap:날짜`(최근 4개, 설정에서 복원).
- 데이터 다이어트: `archiveSweep`이 부팅 시 완료 후 keepMonths 지난 할 일·세션, 종료 후 5년 지난 확정 종료 일정을 보관함으로 이동(+tombstone).

## '지금 이 틈' 추천 로직 (logic.js)
`score = 0.323·prioScore + 0.3145·urgencyScore + 0.2125·fitScore + 0.15·energyFit` (가중 합=1).
energyFit: 모드 미선택=전부 0.6(상수) → 아핀변환이라 **순위 불변**(하드 룰 10). 기본 모드는 `profileMode(시각, settings.focusOrder)`가 결정하고, 미설정이면 `timeOfDayMode` 휴리스틱 폴백. 사용자가 칩을 탭하면 그 선택이 우선(비영속).

## 코드 컨벤션
- DOM 생성 `el(html)`, 이스케이프 `esc()`(사용자 입력은 반드시), 선택 `$()`. 아이콘은 index.html 스프라이트의 `<use href="#i-이름">`을 `svgIco()`(18px)/`cic()`(13px 칩용)로.
- 주석은 한국어로 "왜"를 적는다. 기존 파일의 밀도·톤을 따른다.
- 새 설정 UI는 설정 화면의 카드 패턴(`settings*Card()` 함수 + `.task` 스타일 재사용)을 따른다.

## 남은 향후 후보 (docs/PRODUCT_ROADMAP.md와 연계)
- 외부 캘린더(ICS) 가져오기(회의가 보여야 진짜 틈 계산이 정확), 빠른 추가 자연어 날짜 확장(금요일/다음주 화/7-10), 블록에서 원탭 뽀모도로 시작, GTD 보드 터치 드래그(길게 눌러 이동), 집중 프로파일 연속 가중(opts.focusProfile, Option B로 예약됨).
