/* 틈(TEUM) 순수 도메인 로직 — 앱 상태를 변경하지 않음(인자·전역 헬퍼만 사용).
   constants.js·helpers.js 이후, app.js보다 먼저 로드. */

// 할 일 정렬: 미완료 우선 → 지남 → 우선순위 → 마감 → 생성순 (완료는 최근 완료순)
function sortTasks(ts){
  return ts.slice().sort((a,b)=>{
    if(isDone(a)!==isDone(b)) return isDone(a)?1:-1;
    if(isDone(a)) return (b.completedAt||0)-(a.completedAt||0);
    const ov=(isOverdue(b.due)?1:0)-(isOverdue(a.due)?1:0); if(ov) return ov;
    if(a.priority!==b.priority) return a.priority-b.priority;
    const ad=a.due||'9999', bd=b.due||'9999'; if(ad!==bd) return ad<bd?-1:1;
    return a.createdAt-b.createdAt;
  });
}

// '지금 이 틈' 추천 점수 (틈 적합도 + 마감 긴급도 + 우선순위)
function daysUntil(due){ if(!due) return null; return Math.round((parseDS(due)-parseDS(todayStr()))/86400000); }
function urgencyScore(t){
  const d=daysUntil(t.due);
  if(d==null) return 0.1;
  if(d<0) return 1.0; if(d===0) return 0.9; if(d===1) return 0.7;
  if(d<=3) return 0.55; if(d<=7) return 0.35; return 0.15;
}
function prioScore(t){ return ({1:1,2:0.75,3:0.5,4:0.3})[t.priority]||0.3; }
function fitScore(t,gap){ return t.estimate ? Math.min(1, t.estimate/gap) : 0.45; } // 미입력=중립
function suggestScore(t,gap){
  const score = 0.38*prioScore(t) + 0.37*urgencyScore(t) + 0.25*fitScore(t,gap);
  const d=daysUntil(t.due);
  let reason;
  if(d!=null&&d<0) reason='지난 마감';
  else if(d===0) reason='오늘 마감';
  else if(t.priority<=2) reason='높은 우선순위';
  else if(t.estimate&&t.estimate/gap>=0.7) reason='딱 맞는 시간';
  else if(d!=null&&d<=3) reason='마감 임박';
  else reason='틈에 적합';
  return {score,reason};
}

// 일정 설명 문자열
const ORD_LABEL={1:'첫째',2:'둘째',3:'셋째',4:'넷째',5:'다섯째','-1':'마지막'};
function describeEvent(ev){
  let s;
  if(ev.freq==='once'){
    const range=ev.endDate&&ev.endDate>ev.startDate?` ~ ${ev.endDate}`:'';
    return ev.allDay ? `${ev.startDate}${range} · 종일`
      : `${ev.startDate}${range} · ${minToHHMM(ev.start)}~${minToHHMM(ev.start+ev.duration)}`;
  }
  if((ev.freq||'weekly')==='weekly'){
    const dl=ev.days.slice().sort((a,b)=>a-b).map(d=>DOW[d]).join('·');
    s=(ev.interval>1?`${ev.interval}주마다 `:'매주 ')+dl;
  } else if(ev.monthMode==='weekday'){
    s=(ev.interval>1?`${ev.interval}개월마다 `:'매월 ')+`${ORD_LABEL[ev.ordinal]||''} ${DOW[ev.weekday]}요일`;
  } else {
    const dom=new Date(ev.startDate+'T00:00:00').getDate();
    s=(ev.interval>1?`${ev.interval}개월마다 `:'매월 ')+`${dom}일`;
  }
  s+=` · ${minToHHMM(ev.start)}~${minToHHMM(ev.start+ev.duration)}`;
  if(ev.endMode==='date'&&ev.endDate) s+=` · ~${ev.endDate}`;
  if(ev.endMode==='count'&&ev.count) s+=` · ${ev.count}회`;
  if(ev.excludeHolidays) s+=' · 공휴일 제외';
  return s;
}
// 완전히 지난 일정인가 (목록에서 숨김 대상 — 달력에는 그대로 남음)
function isPastEvent(ev){
  const t=todayStr();
  if(ev.freq==='once') return (ev.endDate||ev.startDate) < t;
  if(ev.endMode==='date'&&ev.endDate) return ev.endDate < t;
  return false; // 종료 없는/횟수 종료 정기 일정은 진행 중으로 간주
}

// PWA 설치 상태/안내
function isStandalone(){ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone===true; }
function installInstructions(){
  const ua=navigator.userAgent;
  if(/iphone|ipad|ipod/i.test(ua)) return 'Safari 하단 공유 버튼(􀈂)을 누르고 "홈 화면에 추가"를 선택하세요.';
  if(/macintosh|mac os x/i.test(ua) && /safari/i.test(ua) && !/chrome|crios|edg|chromium/i.test(ua))
    return 'Safari 메뉴 → 파일 → "Dock에 추가…", 또는 주소창 옆 공유 버튼 → "Dock에 추가"를 선택하세요.';
  if(/android/i.test(ua)) return 'Chrome 메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"를 선택하세요.';
  return '브라우저 주소창 오른쪽의 설치 아이콘(⊕/모니터 모양)을 누르거나, 메뉴에서 "앱 설치"를 선택하세요.';
}

// ---- 타임박스 좌표 수학(순수) — 상수는 인자로 받아 IIFE 의존 제거, 단위 테스트 가능 ----
function tbSnap(m, snap){ return Math.round(m / snap) * snap; }
function tbMinToTop(min, calStart, pxPerMin){ return (min - calStart * 60) * pxPerMin; }
function tbClampMin(min, calStart, calEnd, snap){ return Math.max(calStart * 60, Math.min(calEnd * 60 - snap, min)); }
// 그리드 상단 기준 y(px) → 스냅·클램프된 분
function tbYToMin(yPx, calStart, calEnd, snap, pxPerMin, offsetMin){
  return tbClampMin(tbSnap(calStart * 60 + yPx / pxPerMin - (offsetMin || 0), snap), calStart, calEnd, snap);
}

// 동기화 병합(순수): 로컬+원격을 항목 단위로 합쳐 기기 간 데이터 손실 방지.
//  - tasks: id별 updatedAt 최신 우선
//  - sessions: id 합집합(추가형 로그)
//  - projects/events: id 합집합(최상위 updatedAt이 큰 쪽이 충돌 시 우선)
//  - deletions(tombstone {id:ts}): 합집합(최신 시각). 항목의 updatedAt보다 삭제가 최신이면 제외
//  - settings/top3/weekNotes/holidays: 최상위 updatedAt이 큰 쪽 채택(스칼라성)
function mergeStates(local, remote){
  const L=local||{}, R=remote||{};
  const newer = (R.updatedAt||0) >= (L.updatedAt||0) ? R : L;
  const older = newer===R ? L : R;
  const tomb={};
  for(const m of [L.deletions||{}, R.deletions||{}]) for(const id in m) tomb[id]=Math.max(tomb[id]||0, m[id]||0);
  const alive=(id,upd)=> !(tomb[id] && tomb[id] >= (upd||0));
  // tasks (updatedAt 최신 우선)
  const tById={};
  (L.tasks||[]).forEach(t=>{ tById[t.id]=t; });
  (R.tasks||[]).forEach(t=>{ const e=tById[t.id]; if(!e||(t.updatedAt||0)>(e.updatedAt||0)) tById[t.id]=t; });
  const tasks=Object.values(tById).filter(t=>alive(t.id,t.updatedAt));
  // memos (tasks와 동일: id별 updatedAt 최신 우선, tombstone 적용)
  const mById={};
  (L.memos||[]).forEach(m=>{ mById[m.id]=m; });
  (R.memos||[]).forEach(m=>{ const e=mById[m.id]; if(!e||(m.updatedAt||0)>(e.updatedAt||0)) mById[m.id]=m; });
  const memos=Object.values(mById).filter(m=>alive(m.id,m.updatedAt));
  // folders (memos와 동일 규칙)
  const fById={};
  (L.folders||[]).forEach(f=>{ fById[f.id]=f; });
  (R.folders||[]).forEach(f=>{ const e=fById[f.id]; if(!e||(f.updatedAt||0)>(e.updatedAt||0)) fById[f.id]=f; });
  const folders=Object.values(fById).filter(f=>alive(f.id,f.updatedAt));
  // sessions (합집합)
  const sById={}; (L.sessions||[]).forEach(s=>sById[s.id]=s); (R.sessions||[]).forEach(s=>sById[s.id]=s);
  const sessions=Object.values(sById).filter(s=> !tomb[s.id]);
  // projects/events (memos와 동일: id별 updatedAt 최신 우선, tombstone 적용)
  // 기존엔 최상위 updatedAt 기준 union이라, 다른 기기에서 편집한 일정이 충돌 시 유실되던 문제를 수정.
  const byId=(key)=>{ const o={}; (L[key]||[]).forEach(x=>{o[x.id]=x;}); (R[key]||[]).forEach(x=>{ const e=o[x.id]; if(!e||(x.updatedAt||0)>(e.updatedAt||0)) o[x.id]=x; }); return Object.values(o).filter(x=>alive(x.id,x.updatedAt)); };
  // settings/top3/weekNotes는 키별 얕은 병합(양쪽 변경 보존, 충돌 시 newer 우선),
  // holidays는 합집합 — 기존엔 'newer 통째로'라 한쪽 변경이 유실되던 비대칭 버그 수정.
  const mergeMap=(key)=>Object.assign({}, older[key]||{}, newer[key]||{});
  return {
    tasks, sessions, memos, folders,
    projects: byId('projects'),
    events: byId('events'),
    settings: mergeMap('settings'),
    top3: mergeMap('top3'),
    weekNotes: mergeMap('weekNotes'),
    holidays: [...new Set([...(L.holidays||[]), ...(R.holidays||[])])],
    deletions: tomb,
    updatedAt: Math.max(L.updatedAt||0, R.updatedAt||0)
  };
}
