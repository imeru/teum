# 틈 (TEUM)

> **모든 틈을 의미 있는 진전으로. — Turn every gap into meaningful progress.**

GTD · 타임블로킹 · 뽀모도로 · 캘린더를 결합해, "지금 가진 틈으로 무엇을 해낼 수 있는가"를 돕는 **의도적 시간관리 PWA**입니다.
빌드 도구·프레임워크 없는 바닐라 JS 단일 페이지 앱으로, 하나의 코드가 **윈도우 · 맥 · 모바일** 브라우저에서 동작하고 앱처럼 설치됩니다.

**▶ 바로 써보기: https://imeru.github.io/teum/**

---

## 핵심 기능

- **할 일 / GTD** — 제목·메모·마감(일/시간)·태그·우선순위(P1~P4)·예상 소요시간. Inbox → 다음 행동 / 대기 중 / 언젠가 / 완료 분류, 프로젝트·태그(컨텍스트)
- **타임박스** — 미니 월달력 + TOP3 + 할 일 풀 + 정기 일정 / 주간 스트립 + 일간 시간표(06~24시, 10분 스냅). 할 일을 끌어다 시간 블록으로 배치, 블록 이동·길이 조절
- **스마트 추천** — "지금 이 틈"에 가용 시간·우선순위·소요시간 기준으로 할 일 제안
- **뽀모도로** — 집중/휴식 타이머(뷰 전환에도 유지), 세션 기록
- **일일 리뷰** — 완료/남은 일 정리
- **정기 일정** — 주/월 반복, 격주·격월, 매월 n번째 요일, 종료일/횟수, 공휴일 제외
- **클라우드 동기화** — Google 로그인 한 번으로 모든 기기에서 같은 데이터 (Supabase, 본인 데이터만 접근)
- **오프라인 지원** — 서비스워커 캐시로 인터넷 없이도 실행 (최초 로그인은 온라인 필요)

설계 철학·기능 우선순위·디자인 원칙은 [`docs/`](docs/) 문서 세트를 참고하세요.

---

## 써보기 (사용자)

설치나 설정이 필요 없습니다.

1. **https://imeru.github.io/teum/** 접속
2. **"Google로 시작하기"** 클릭 → 로그인
3. 끝. 이후 어느 기기에서든 같은 Google 계정으로 로그인하면 데이터가 자동 동기화됩니다.

브라우저 메뉴에서 **"홈 화면에 추가 / 앱 설치"** 를 누르면 독립 앱(PWA)으로 설치됩니다.

### 빠른 추가 문법

입력창에서 한 줄로 작성:

| 표기 | 의미 | 예 |
|------|------|----|
| `!1`~`!4` | 우선순위 | `보고서 !1` |
| `@태그` | 태그(컨텍스트) | `@연구 @집` |
| `#이름` | 프로젝트(맨 뒤, 기존 프로젝트명과 일치 시) | `#논문 투고` |
| `오늘`/`내일` | 마감일 | `미팅 준비 내일` |

예) `학회 초록 작성 !2 @연구 #논문 투고 오늘`

---

## 직접 배포하기 (개발자 / 셀프 호스팅)

이 저장소를 포크해 **본인 백엔드**로 운영하려는 경우의 안내입니다. 일반 사용자는 위 "써보기"만 보면 됩니다.

### 1) 정적 호스팅

빌드가 없으므로 파일을 그대로 HTTPS에 올리면 됩니다.

- **GitHub Pages** — 저장소 → Settings → Pages → Branch `main` / `root` 지정 → `https://<계정>.github.io/<저장소>/`
- **Netlify / Vercel** — 폴더를 드래그&드롭하면 즉시 HTTPS 주소 발급

> `index.html`을 파일로 직접 열어도(로컬 저장) 동작하지만, **PWA 설치·서비스워커·로그인은 HTTPS 호스팅에서만** 됩니다(`file://`에서는 OAuth 리디렉션 불가).

### 2) Supabase 백엔드

1. [supabase.com](https://supabase.com) 무료 프로젝트 생성
2. **SQL Editor**에서 테이블 + 보안 정책 생성. 정책은 **로그인 사용자가 자기 행(`u_<본인ID>`)만** 읽고 쓰도록 잠급니다:

```sql
create table if not exists flowdo (   -- 테이블명은 레거시로 flowdo 유지
  id text primary key,
  data jsonb,
  updated_at bigint
);
alter table flowdo enable row level security;

create policy "own row" on flowdo
  for all to authenticated
  using ( id = 'u_' || auth.uid()::text )
  with check ( id = 'u_' || auth.uid()::text );
```

3. **Settings → API**에서 **Project URL**과 **publishable(anon) key**를 복사해 [`app.js`](app.js)의 `DEFAULT_CLOUD`에 입력:

```js
const DEFAULT_CLOUD = {
  url: 'https://<프로젝트ID>.supabase.co',
  key: 'sb_publishable_...'   // anon/publishable 키 — 클라이언트 공개용. 보안은 위 RLS가 담당
};
```

> publishable(anon) 키는 **클라이언트에 공개되도록 설계된 키**라 저장소에 포함해도 안전합니다. 실제 데이터 보호는 RLS 정책이 합니다. (`service_role`/secret 키는 절대 넣지 마세요.)

### 3) Google 로그인 (OAuth)

1. **Supabase → Authentication → Sign In / Providers → Google** 활성화. 화면의 **Callback URL**(`https://<프로젝트ID>.supabase.co/auth/v1/callback`)을 복사
2. **Google Cloud Console → Google Auth Platform**
   - **Branding / Audience**: 외부(External)로 구성, 앱 게시(Publish)하면 누구나 로그인 가능(미게시 시 테스트 사용자만)
   - **Clients → Create client (Web application)**:
     - **승인된 자바스크립트 원본**: 앱 호스팅 도메인 (예: `https://imeru.github.io`)
     - **승인된 리디렉션 URI**: 위 Supabase Callback URL
   - 발급된 **Client ID / Secret**을 Supabase Google provider에 입력 → 저장
3. **Supabase → Authentication → URL Configuration**: **Site URL**과 **Redirect URLs**에 앱 주소(예: `https://imeru.github.io/teum/`) 등록

앱의 로그인 리디렉션 주소는 `location.origin + location.pathname` 입니다(서브경로 포함). Supabase Redirect URLs에 정확히 일치하는 주소를 넣어야 로그인 후 앱으로 돌아옵니다.

---

## 파일 구성

```
index.html         UI 마크업 + 전체 CSS + 로그인 게이트 + 모달
app.js             앱 로직(IIFE) — 상태·렌더·드래그·동기화·추천·리뷰·정기일정
manifest.json      PWA 설치 정보
service-worker.js  오프라인 캐시
icons/             앱 아이콘 · 로고(symbol / horizontal)
docs/              제품 설계 문서 세트(브랜드·원칙·기능·디자인·로드맵·페르소나)
CLAUDE.md          기여 가이드 · 데이터 모델 · 컨벤션
```

데이터 모델(localStorage 키 `flowdo.state.v1`)과 코드 컨벤션은 [CLAUDE.md](CLAUDE.md)에 정리되어 있습니다.

---

## 다음 후보 (로드맵)

- 주간 리뷰(GTD weekly review) 화면
- Supabase 클라이언트 라이브러리 번들(CDN 의존 제거 → 완전 오프라인 지원 강화)
- 블록 겹침 나란히 배치, 알림
- 블록 시작 시각 미세 이동

자세한 방향은 [`docs/PRODUCT_ROADMAP.md`](docs/PRODUCT_ROADMAP.md) 참고.
