# FlowDo — GTD · 타임블락킹 할 일 관리 앱

TickTick · ToDoMaster를 참고해 만든 **크로스플랫폼 PWA** 할 일 관리 앱입니다.
하나의 코드로 **윈도우 · 맥 · 모바일** 브라우저에서 모두 동작하며, 앱처럼 설치할 수 있습니다.

## 핵심 기능

- **기본 할 일** — 제목·메모·마감일·태그·우선순위(P1~P4), 완료/삭제, 빠른 추가
- **GTD** — Inbox(수집) → 다음 행동 / 대기 중 / 언젠가 분류, 프로젝트·컨텍스트(태그)
- **타임블락킹** — 하루 시간표에 할 일을 끌어다 놓아 시간 블록으로 배치
- **클라우드 동기화** — Supabase 연결 시 여러 기기에서 같은 데이터 사용
- **오프라인 지원** — 서비스워커 캐시로 인터넷 없이도 실행

## 빠른 추가 문법

입력창에서 한 줄로 작성:

| 표기 | 의미 | 예 |
|------|------|----|
| `!1`~`!4` | 우선순위 | `보고서 !1` |
| `@태그` | 태그 | `@연구 @집` |
| `#이름` | 프로젝트(맨 뒤, 기존 프로젝트명과 일치 시) | `#논문 투고` |
| `오늘`/`내일` | 마감일 | `미팅 준비 내일` |

예) `학회 초록 작성 !2 @연구 #논문 투고 오늘`

## 실행 방법

### 1) 가장 간단 — 파일 더블클릭
`index.html`을 브라우저로 엽니다. 바로 사용 가능(로컬 저장).
단, 이 방식은 **PWA 설치·서비스워커가 비활성**입니다.

### 2) 권장 — 무료 호스팅으로 배포 (설치형 PWA)
PWA 설치와 동기화를 제대로 쓰려면 HTTPS 주소가 필요합니다.

**GitHub Pages**
1. 새 저장소를 만들고 이 폴더의 모든 파일 업로드
2. Settings → Pages → Branch를 `main` / `root`로 지정
3. 발급된 `https://...github.io/...` 주소 접속

**Netlify / Vercel** — 폴더를 드래그&드롭하면 즉시 HTTPS 주소 발급

접속 후 브라우저 메뉴에서 **"홈 화면에 추가 / 앱 설치"**를 누르면 독립 앱이 됩니다.

## 클라우드 동기화 설정 (선택)

1. [supabase.com](https://supabase.com) 무료 프로젝트 생성
2. **SQL Editor**에 아래를 실행해 테이블 생성:

```sql
create table if not exists flowdo (
  id text primary key,
  data jsonb,
  updated_at bigint
);
alter table flowdo enable row level security;
create policy "anon all" on flowdo
  for all to anon using (true) with check (true);
```

3. 앱 → **설정**에서 입력:
   - **Project URL** (Settings → API)
   - **anon public key** (Settings → API)
   - **스페이스 ID** — 원하는 고유 문구(예: `eden-2026`). 모든 기기에서 같은 값 사용
4. **연결 저장** → 이후 변경 사항은 자동 업로드, 다른 기기에서 **서버에서 불러오기**

> 개인용 단순 구성입니다. 스페이스 ID를 아는 사람은 데이터 접근이 가능하므로, 추측하기 어려운 문구를 쓰세요.

## Google 계정 로그인 (기기 간 자동 동기화)

스페이스 ID 대신 **Google 로그인**으로 본인 계정의 데이터를 어느 기기에서나 자동 동기화할 수 있습니다. 위 Supabase 연결을 먼저 마친 뒤 다음을 설정합니다.

1. **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)) → 프로젝트 생성 → **API 및 서비스 → OAuth 동의 화면** 구성(외부, 본인 이메일 테스트 사용자 추가).
2. **사용자 인증 정보 → OAuth 2.0 클라이언트 ID(웹 애플리케이션)** 생성. 발급되는 **Client ID / Client Secret**을 복사.
3. **Supabase 대시보드 → Authentication → Providers → Google** 활성화 후 Client ID/Secret 입력. 이때 Supabase가 보여주는 **콜백 URL**(`https://<프로젝트>.supabase.co/auth/v1/callback`)을 복사.
4. 다시 Google Cloud Console의 OAuth 클라이언트 → **승인된 리디렉션 URI**에 그 콜백 URL을 등록. **승인된 자바스크립트 원본**에는 앱을 호스팅한 주소(예: `https://yourname.github.io`)를 등록.
5. Supabase **Authentication → URL Configuration → Site URL / Redirect URLs**에 앱 호스팅 주소를 등록.
6. SQL 정책을 로그인 사용자도 쓸 수 있게 설정(앱 설정 화면의 SQL 사용):

```sql
alter table flowdo enable row level security;
create policy "rw" on flowdo
  for all to anon, authenticated using (true) with check (true);
```

설정 후 앱 → **설정 → 👤 Google 계정 로그인 → "Google 계정으로 로그인"**을 누르면, 이후 모든 기기에서 같은 계정으로 로그인하면 데이터가 자동 동기화됩니다.

> 로그인 기능은 **HTTPS로 호스팅된 주소**에서만 동작합니다(파일 직접 열기·`file://`에서는 OAuth 리디렉션이 작동하지 않음). 더 강한 보안이 필요하면 RLS 정책을 `auth.uid()` 기반으로 좁힐 수 있습니다.

## 파일 구성

```
index.html         메인 UI
app.js             앱 로직 (GTD·타임블락·동기화)
manifest.json      PWA 설치 정보
service-worker.js  오프라인 캐시
icons/             앱 아이콘
```

## 다음 확장 후보

- 뽀모도로 타이머(25/5분)와 할 일 연동, 집중 세션 기록
- 반복 일정, 알림
- 주간 리뷰(GTD weekly review) 화면
