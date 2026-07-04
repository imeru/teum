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
// 데이터 다이어트 — cutoffMs 이전에 끝난 완료 할 일·세션을 보관 대상으로 분리(순수).
// 완료 시각은 completedAt, 없으면 updatedAt 폴백. 미완료 할 일은 절대 대상 아님.
function splitArchive(tasks, sessions, cutoffMs){
  const doneAt=t=>t.completedAt||t.updatedAt||0;
  const arcTasks=(tasks||[]).filter(t=>isDone(t) && doneAt(t)>0 && doneAt(t)<cutoffMs);
  const ids=new Set(arcTasks.map(t=>t.id));
  const keepTasks=(tasks||[]).filter(t=>!ids.has(t.id));
  const sAt=s=>s.at || (s.date?parseDS(s.date).getTime():0);
  const arcSessions=(sessions||[]).filter(s=>sAt(s)>0 && sAt(s)<cutoffMs);
  const sids=new Set(arcSessions.map(s=>s.id));
  const keepSessions=(sessions||[]).filter(s=>!sids.has(s.id));
  return {keepTasks, arcTasks, keepSessions, arcSessions};
}
// 오래된 tombstone 정리 — cutoffMs 이전 삭제 기록 제거(동기화 페이로드 억제).
function pruneTombstones(deletions, cutoffMs){
  const out={};
  for(const k in (deletions||{})) if(deletions[k]>=cutoffMs) out[k]=deletions[k];
  return out;
}
// 반복 할 일 — 다음 회차 마감일. monthly는 말일 클램프(1/31 → 2/28).
function nextRepeatDate(repeat, fromDS){
  if(repeat==='daily') return addDaysDS(fromDS,1);
  if(repeat==='weekly') return addDaysDS(fromDS,7);
  if(repeat==='monthly'){
    const d=parseDS(fromDS), day=d.getDate();
    const last=new Date(d.getFullYear(), d.getMonth()+2, 0).getDate(); // 다음 달 말일
    return todayStr(new Date(d.getFullYear(), d.getMonth()+1, Math.min(day,last)));
  }
  return null;
}
// 타임박스 겹침 — 시간 구간들을 겹침 클러스터별로 레인 배정(나란히 배치용).
// items: [{start,end}](분) → [{lane, lanes}] (lanes = 그 클러스터의 총 레인 수)
function assignLanes(items){
  const order=[...items.keys()].sort((a,b)=>items[a].start-items[b].start || items[b].end-items[a].end);
  const res=items.map(()=>({lane:0,lanes:1}));
  let cluster=[], laneEnd=[], clusterEnd=0;
  const flush=()=>{ cluster.forEach(i=>res[i].lanes=laneEnd.length); cluster=[]; laneEnd=[]; clusterEnd=0; };
  order.forEach(i=>{
    const s=items[i].start, e=items[i].end;
    if(cluster.length && s>=clusterEnd) flush();      // 이전 클러스터와 안 겹침 → 확정
    let l=0; while(laneEnd[l]!=null && laneEnd[l]>s) l++; // 끝==시작은 겹침 아님
    laneEnd[l]=e; res[i].lane=l; cluster.push(i);
    clusterEnd=Math.max(clusterEnd,e);
  });
  flush();
  return res;
}
// 마감 근접도 → 강조 단계(가까울수록 진하게). urgencyScore와 동일 버킷.
function dueLevel(due){
  const d=daysUntil(due);
  if(d==null) return null;
  if(d<0) return 'over';   // 지남(가장 진하게)
  if(d===0) return 'd0';   // 오늘
  if(d===1) return 'd1';   // 내일
  if(d<=3) return 'soon';  // 2~3일
  if(d<=7) return 'week';  // 이번 주
  return 'far';            // 멀다(흐리게)
}
function urgencyScore(t){
  const d=daysUntil(t.due);
  if(d==null) return 0.1;
  if(d<0) return 1.0; if(d===0) return 0.9; if(d===1) return 0.7;
  if(d<=3) return 0.55; if(d<=7) return 0.35; return 0.15;
}
function prioScore(t){ return ({1:1,2:0.75,3:0.5,4:0.3})[t.priority]||0.3; }
function fitScore(t,gap){ return t.estimate ? Math.min(1, t.estimate/gap) : 0.45; } // 미입력=중립
// 에너지/집중도 적합도: 모드 미설정(null/undefined)→0.6 전역중립. 모드와 task.weight 일치=1.0, 반대=0.2, 중립(null)=0.6.
function energyFit(weight, mode){
  if(mode!=='light'&&mode!=='focus') return 0.6;       // 모드 미설정 → 중립
  if(weight!=='light'&&weight!=='focus') return 0.6;   // task 중립
  return weight===mode ? 1.0 : 0.2;
}
// 시간대 기본 모드(순수): 오전 집중, 이른 오후·늦은 저녁 가벼움, 그 외 중립(null).
function timeOfDayMode(hour){
  if(hour>=6&&hour<=11) return 'focus';
  if(hour>=13&&hour<=16) return 'light';
  if(hour>=21&&hour<=23) return 'light';
  return null;
}
// 개인 집중 프로파일 — 하루 06~24시를 6개 거친 블록 [start,end)로. 라벨/색은 UI 전용.
const FOCUS_BLOCKS = [['dawn',6,9],['morn',9,12],['lunch',12,14],['noon',14,18],['eve',18,21],['night',21,24]];
const FOCUS_KEYS = FOCUS_BLOCKS.map(b=>b[0]);
function hourToBlock(hour){
  const h=Number(hour);
  if(!Number.isFinite(h)) return null;
  if(h<6||h>=24) return null;                       // 새벽 00~05 / 24↑ 미커버
  for(const b of FOCUS_BLOCKS){ if(h>=b[1]&&h<b[2]) return b[0]; }
  return null;
}
// 완전 순열만 인정(길이6·6키 정확히 1회씩). 아니면 전면 폴백.
function isValidFocusOrder(o){
  if(!Array.isArray(o)||o.length!==6) return false;
  for(const k of FOCUS_KEYS){ if(o.indexOf(k)===-1) return false; }
  return new Set(o).size===6;
}
function focusRank(hour, focusOrder){               // 0=최고집중 .. 5=최저, -1=미설정/무효/미커버→폴백
  if(!isValidFocusOrder(focusOrder)) return -1;
  const blk=hourToBlock(hour);
  if(blk==null) return -1;
  return focusOrder.indexOf(blk);
}
function focusLevel(hour, focusOrder){              // 정규화 레벨(테스트·UI), 폴백이면 null
  const r=focusRank(hour, focusOrder);
  return r<0 ? null : (5-r)/5;                       // {1.0,0.8,0.6,0.4,0.2,0.0}
}
// 그 시각의 기본 energyMode를 정함. 미설정/무효/미커버 → 기존 휴리스틱(불변식 보장).
function profileMode(hour, focusOrder){
  const r=focusRank(hour, focusOrder);
  if(r<0) return timeOfDayMode(hour);
  if(r<=1) return 'focus';                           // 상위 2블록
  if(r>=4) return 'light';                           // 하위 2블록
  return null;                                        // 중간 2블록 = 중립
}
function suggestScore(t,gap,opts={}){
  // 가중치 합=1. opts.energyMode 미설정이면 energyFit=0.6 상수 → new=0.85*old+0.09 아핀변환(정렬 불변).
  const score = 0.323*prioScore(t) + 0.3145*urgencyScore(t) + 0.2125*fitScore(t,gap) + 0.15*energyFit(t.weight, opts.energyMode);
  const d=daysUntil(t.due);
  let reason;
  if(d!=null&&d<0) reason='지난 마감';
  else if(d===0) reason='오늘 마감';
  else if(t.priority<=2) reason='높은 우선순위';
  else if(t.estimate&&t.estimate/gap>=0.7) reason='딱 맞는 시간';
  else if(d!=null&&d<=3) reason='마감 임박';
  else if((opts.energyMode==='light'||opts.energyMode==='focus')&&opts.energyMode===t.weight) reason=t.weight==='light'?'가벼운 일':'집중할 일';
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
