# 작업 인수인계 (Cowork → Claude Code)

> 이 파일은 Cowork에서 진행한 작업을 Claude Code로 이어가기 위한 요약입니다.
> 제품 원칙·데이터 모델은 `CLAUDE.md`와 `docs/`를 기준으로 합니다.

## 현재 상태 (요약)
브랜드 **틈 (TEUM)** — GTD·타임블로킹·뽀모도로·캘린더를 결합한 의도적 시간관리 PWA. 빌드 도구 없는 바닐라 JS 단일 페이지 앱.

지금까지 구현·완료된 것:
- 기본 할 일(제목·메모·마감일/시간·태그·우선순위·예상 소요시간), GTD 분류(Inbox/다음행동/대기/언젠가/완료)
- 타임박스: 좌측 미니 월달력 + TOP3 + 할 일 풀 + 정기일정, 우측 주간 스트립 + 일간 시간표(06~24시, **10분 단위 스냅**), 블록 자유 드래그 이동·길이 조절, 드롭 인디케이터, 현재시각 빨간 선
- 양방향 드래그: 할 일 ↔ 캘린더/TOP3/날짜셀/사이드바(GTD상태·프로젝트·태그·오늘 변경, `makeNavDrop`)
- 뽀모도로(타이머 유지·세션 기록), 스마트 추천("지금 이 틈"), 일일 리뷰
- 정기 일정: 주/월 반복, 격주·격월(interval), 요일 기반 월간(매월 n번째 요일), 시작/종료일·횟수 종료, 공휴일 제외
- 클라우드 동기화(Supabase) + Google 로그인(계정 기반), 공휴일 관리, JSON 백업/복원
- **브랜드 적용 완료**: 공식 SVG 로고 팩(`TEUM_SVG_Logo_Pack/`) 기반 아이콘(`icons/icon-192/512.png`)·사이드바 심볼(`icons/logo-symbol-tight.svg`), 팔레트(네이비 #102334·세이지 #83BFA7·중립), `manifest.json` theme_color #102334, SW 캐시 `teum-v4`

## 파일
- `index.html` — UI 마크업 + 전체 CSS(`<style>`) + 모달들
- `app.js` — 전체 로직(IIFE). 상태·렌더·드래그·동기화·추천·리뷰·정기일정 엔진
- `manifest.json` / `service-worker.js` / `icons/`
- `docs/` — 제품 설계 문서 세트(기능·디자인 결정 전 항상 참고)
- `TEUM_SVG_Logo_Pack/` — 공식 로고 SVG 원본

## 테스트 방법
- `node --check app.js`로 문법 검사
- jsdom으로 `index.html`+`app.js` 평가 후 DOM 상호작용 시뮬레이션(렌더·드래그·이벤트). 새 기능은 헤드리스로 검증해 왔음.

## 알려진 정리 거리
- `icons/logo-mark.png`, `icons/_sidebar_preview.png` — 이전 단계의 미사용 임시 파일(삭제 가능)
- 루트에 `TEUM_Claude_Project/`, `TEUM_Product_Documentation*`, `*.zip` 등 참고 자료가 함께 있음

## 다음 후보 (로드맵 `docs/PRODUCT_ROADMAP.md` 연계)
- 빈 화면/상단바에 가로형 로고(`teum-logo-horizontal.svg`) 적용, 설치 splash
- 주간 리뷰(GTD weekly review) 화면
- 블록 겹침 나란히 배치, 알림
- Supabase RLS를 `auth.uid()` 기반으로 강화
- 폴더를 Git 저장소로 초기화해 버전 관리 시작 권장
