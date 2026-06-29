# 틈 (TEUM) — 프로젝트 안내 (Claude / Claude Code용)

> **모든 틈을 의미 있는 진전으로. (Turn every gap into meaningful progress.)**

브랜드명 **틈 (TEUM)**. GTD · 타임블로킹 · 뽀모도로 · 캘린더를 결합해, "지금 가진 틈으로 무엇을 해낼 수 있는가"를 돕는 **의도적 시간관리 PWA**.
현재 구현은 빌드 도구·프레임워크 없는 바닐라 JS 단일 페이지 앱(이전 이름 FlowDo에서 리브랜딩 중).

## ⚠️ 항상 먼저 참고할 제품 설계 문서 세트 (`docs/`)
모든 기능 추가·수정·디자인 결정 전에 아래 문서를 **반드시 참고**하고 그 원칙에 맞춰 작업한다. 충돌 시 이 문서들이 기준이다.

- `docs/BRAND.md` — 브랜드 철학·미션·태그라인·제품 비전
- `docs/PRODUCT_PRINCIPLES.md` — 핵심 원칙(시간이 작업보다 먼저), 일일 워크플로(Capture→Clarify→Estimate→Schedule→Focus→Complete→Reflect), 성공 지표
- `docs/FEATURE_PHILOSOPHY.md` — 무엇을 만들고 무엇을 만들지 않는가, 기능 우선순위(Must/Nice/Avoid)
- `docs/FEATURE_SPEC.md` — Inbox/Today/Time Slots/Smart Suggestion/Focus Mode/Daily Review 사양
- `docs/DESIGN_LANGUAGE.md` — 차분·여백·미니멀, 색 의미(초록=진전, 파랑=집중, 앰버=주의, 빨강=지연만), 정보 위계
- `docs/AI_PRINCIPLES.md` — "AI는 추천, 결정은 사람." 해도 되는 것/절대 안 되는 것
- `docs/PRODUCT_ROADMAP.md` — Phase 1~3 및 장기 비전
- `docs/USER_PERSONAS.md` — 지식노동자·대학원생·바쁜 부모·창작자, 공통 목표

## 기능 판단 기준 (새 기능을 만들기 전 자문)
1. 틈(짜투리 시간) 활용을 돕는가?  2. 인지 부하를 줄이는가?  3. 집중을 돕는가?
4. 인터페이스를 더 단순하게 하는가?  5. 새 사용자가 즉시 이해하는가?
→ 아니면 만들지 않는다. **의심스러우면 더하지 말고 덜어낸다.** 명료함·집중·차분함이 곧 기능.

## 핵심 설계 원칙 (요약)
- 단순함 > 유연함, 가독성 > 영리함, 작은 재사용 컴포넌트.
- 모바일 우선, 차분한 인터페이스, 화면당 주요 행동 하나.
- 색은 의미를 전달할 때만(장식 금지). 여백은 기능이다.
- 상태 변경 후 항상 `save()` → `render()`/`renderPlan()`. UI 텍스트는 한국어.
- 커밋 접두사: `feat: fix: refactor: docs: test: style: chore:`

## 파일 구성
- `index.html` — UI 마크업 + 전체 CSS(`<style>`). 모달(할 일/프로젝트/정기일정) 포함.
- `app.js` — 앱 로직(IIFE). 상태관리·렌더링·드래그·동기화.
- `manifest.json`, `service-worker.js`, `icons/` — PWA 설치·오프라인.
- `docs/` — **제품 설계 문서 세트(위 참조).**
- `README.md` — 실행·배포(GitHub Pages/Netlify)·Supabase·Google 로그인 설정.

## 실행 / 테스트
- 실행: `index.html`을 브라우저로 열면 됨(로컬 저장). PWA·동기화는 HTTPS 호스팅 필요.
- 로직 검증은 헤드리스로 해왔음: jsdom으로 `index.html`+`app.js` 평가 후 DOM 상호작용 시뮬레이션.
  예) `node --check app.js` 문법 검사 후, jsdom 스크립트로 렌더·드래그·이벤트 테스트.

## 데이터 모델 (localStorage 키 `flowdo.state.v1`)
- `tasks[]`: `{id,title,notes,status,priority(1~4),tags[],projectId,due,dueTime,block,weight,createdAt,updatedAt,completedAt}`
  - `weight`: `'light' | 'focus' | null` — 에너지/집중도. '지금 이 틈' 추천의 energyFit 가중에 사용(비영속 에너지 모드와 결합).
  - `status`: inbox | next | waiting | someday | done (GTD 분류)
  - `block`: `{date, start(분), duration(분)}` — 타임박스 배치
- `projects[]`: `{id,name,color}`
- `sessions[]`: 뽀모도로 집중 기록 `{id,taskId,date,duration,at}`
- `settings`: `{focus,short,long,longEvery}` (뽀모도로 분 단위) + `notify,notifyLead`(알림) + `focusOrder`(개인 집중 프로파일: 6블록 키 순열 또는 null=미설정 → '지금 이 틈' 기본 모드 결정. 미설정/무효 시 timeOfDayMode 폴백 → 추천 순위 불변)
- `top3`: `{ 'YYYY-MM-DD': [taskId,taskId,taskId] }` (날짜별 우선순위 TOP3)
- `events[]`: 정기(반복) 일정
  - `{id,title,start,duration,color,freq,interval,days[],monthMode,ordinal,weekday,startDate,endMode,endDate,count,excludeHolidays}`
  - `freq`: weekly | monthly / `monthMode`: date | weekday(매월 n번째 요일) / `endMode`: never | date | count
- `holidays[]`: 'YYYY-MM-DD' 문자열. `excludeHolidays`인 이벤트에서 제외.
- 기존 데이터는 `migrate()`에서 누락 필드 보강.

## 주요 화면 (뷰)
- **타임박스(plan)**: 기본 화면. 좌측 = 미니월달력 + TOP3 + 할 일 풀 + 정기일정, 우측 = 주간 스트립 + 일간 시간표.
  - 시간표: 06~24시, **10분 단위 스냅**, 1분=1px. 할 일 드래그 배치, 블록 자유 이동, 하단 핸들로 길이 조절. 현재시각 빨간 선.
- **목록 뷰**: today/inbox/next/waiting/someday/done — `taskRow()`로 렌더.
- **뽀모도로**: 타이머(다른 뷰로 이동해도 유지), 세션 기록.
- **설정**: Supabase 연결 + Google 로그인, 공휴일 관리, JSON 백업/복원.

## 드래그앤드롭 규칙
- 할 일 카드(목록/풀/TOP3/블록)는 `dataTransfer`에 task id를 실음.
- 드롭 대상: 시간표 슬롯(배치), TOP3 슬롯(우선순위), 주간 날짜 셀(마감일 변경),
  좌측 풀(배치/우선순위 해제), **사이드바 항목**(GTD 상태/프로젝트/태그/오늘 변경 — `makeNavDrop`).

## 클라우드 동기화
- Supabase(`flowdo` 테이블, row id=동기화 키, data jsonb, last-write-wins).
- 동기화 키: 로그인 시 `u_<user.id>`, 아니면 수동 `space` ID.
- Google 로그인: `supabase.auth.signInWithOAuth({provider:'google'})`. HTTPS 호스팅에서만 동작.

## 코드 컨벤션
- 프레임워크 없음. `el(html)`로 DOM 생성, `$()`=querySelector, `esc()`로 이스케이프.

## 향후 후보 (로드맵과 연계, `docs/PRODUCT_ROADMAP.md` 참조)
- 스마트 추천(가용 시간·우선순위·소요시간·마감 기반 "지금 이 틈에 할 일" 제안), 작업 소요시간 추정, 일일 리뷰 화면.
- 블록 시작 시각 미세 이동, 블록 겹침 나란히 배치, 주간 리뷰(GTD weekly review).
- RLS를 `auth.uid()` 기반으로 강화.
