/* FlowDo — GTD · 타임블락킹 할 일 관리 (단일 PWA, vanilla JS) */
(() => {
  'use strict';

  // ---------- State ----------
  const LS_KEY = 'flowdo.state.v1';
  const CFG_KEY = 'flowdo.cloud.v1';
  // PROJECT_COLORS/DOW/STATUS/FREQ/PLANVIEW → constants.js, 순수 헬퍼 → helpers.js
  // 공용 백엔드: anon(publishable) 키는 클라이언트 공개용이며 데이터 보호는 RLS가 담당.
  // 모든 방문자가 별도 설정 없이 같은 백엔드로 Google 로그인 → 자동 동기화.
  const DEFAULT_CLOUD = {
    url: 'https://btmyvomigijtikajaazv.supabase.co',
    key: 'sb_publishable_PCfTgna_8CzZBS3F_Gi9AA_y5P-hFUn'
  };

  let state = load();
  let cloud = loadCfg();
  let currentView = 'today';
  let currentFilter = null; // {type:'project'|'tag', value}
  let editingId = null;
  let selectedPrio = 4;
  let projColor = PROJECT_COLORS[0];
  let supa = null;          // supabase client
  let syncTimer = null;
  let lastSyncSig = '';     // 마지막으로 서버에 올린 내용 시그니처(중복 업로드 방지)
  let authUser = null;      // 로그인된 Google 계정
  let authChecked = false;  // 세션 확인 완료 여부 (게이트 로딩 표시용)
  let deferredInstall = null; // PWA 설치 프롬프트 (Chromium 계열)
  function syncKey(){ return authUser ? ('u_'+authUser.id) : (cloud.space||''); }

  // Pomodoro runtime (lives across view switches)
  const pomo = { mode:'focus', remaining:25*60, running:false, taskId:'', cycle:0, interval:null };

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  function defaultState(){
    return {
      tasks: [
        demo('연구 미팅 자료 정리', 'next', 2, ['@연구'], todayStr()),
        demo('이메일 회신 (학과)', 'inbox', 3, ['@행정'], null),
        demo('논문 리비전 아이디어 메모', 'someday', 4, ['@연구'], null),
        demo('공동연구자 회신 대기', 'waiting', 3, [], null),
      ],
      projects: [{id:uid(), name:'논문 투고', color:PROJECT_COLORS[0]}],
      sessions: [],
      settings: { focus:25, short:5, long:15, longEvery:4, notify:false, notifyLead:5 },
      top3: {},
      events: [],
      holidays: [],
      weekNotes: {},
      updatedAt: Date.now()
    };
  }
  function demo(title,status,prio,tags,due){
    return {id:uid(),title,notes:'',status,priority:prio,tags,due,projectId:'',
      block:null,createdAt:Date.now(),updatedAt:Date.now(),completedAt:null};
  }
  function load(){
    try{ const s=JSON.parse(localStorage.getItem(LS_KEY)); if(s&&s.tasks) return migrate(s); }catch(e){}
    return defaultState();
  }
  function migrate(s){
    if(!s.sessions) s.sessions=[];
    if(!s.settings) s.settings={ focus:25, short:5, long:15, longEvery:4, notify:false, notifyLead:5 };
    if(s.settings.notify===undefined) s.settings.notify=false;
    if(s.settings.notifyLead===undefined) s.settings.notifyLead=5;
    if(!s.top3) s.top3={};
    if(!s.events) s.events=[];
    if(!s.holidays) s.holidays=[];
    s.events.forEach(ev=>{
      if(!ev.freq){ ev.freq='weekly'; ev.interval=ev.interval||1; ev.startDate=ev.startDate||todayStr(); ev.endMode=ev.endMode||'never'; ev.endDate=ev.endDate||null; ev.count=ev.count||null; }
      if(ev.freq==='monthly'&&!ev.monthMode) ev.monthMode='date';
      if(ev.excludeHolidays===undefined) ev.excludeHolidays=false;
    });
    (s.tasks||[]).forEach(t=>{ if(!Array.isArray(t.subtasks)) t.subtasks=[]; });
    if(!s.weekNotes) s.weekNotes={};
    return s;
  }
  function loadCfg(){
    // 내장 기본값(공용 백엔드)에 로컬 오버라이드(스페이스 ID 등)를 병합.
    let saved={}; try{ saved=JSON.parse(localStorage.getItem(CFG_KEY))||{}; }catch(e){}
    return Object.assign({}, DEFAULT_CLOUD, saved);
  }
  function save(){
    state.updatedAt = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    scheduleSync();
  }

  // ---------- Date/DOM helpers는 helpers.js, 상수는 constants.js로 분리됨 ----------
  // 정기 일정이 특정 날짜(ds)에 발생하는가
  function eventOccursOn(ev,ds){
    if(!ev.startDate) ev.startDate=ds;
    if(ev.freq==='once'){ const end=ev.endDate||ev.startDate; return ds>=ev.startDate && ds<=end; }
    if(ds<ev.startDate) return false;
    if(ev.endMode==='date'&&ev.endDate&&ds>ev.endDate) return false;
    if(ev.excludeHolidays&&(state.holidays||[]).includes(ds)) return false;
    const target=new Date(ds+'T00:00:00'), startD=new Date(ev.startDate+'T00:00:00');
    const interval=ev.interval||1;
    if((ev.freq||'weekly')==='weekly'){
      if(!ev.days||!ev.days.includes(target.getDay())) return false;
      const wi=Math.round((startOfWeek(target)-startOfWeek(startD))/(7*86400000));
      if(wi<0||wi%interval!==0) return false;
    } else {
      const occ=monthlyOccDate(ev,target.getFullYear(),target.getMonth());
      if(!occ||!sameDay(occ,target)||occ<startD) return false;
      const mi=(target.getFullYear()-startD.getFullYear())*12+(target.getMonth()-startD.getMonth());
      if(mi<0||mi%interval!==0) return false;
    }
    if(ev.endMode==='count'&&ev.count){ if(occurrenceOrdinal(ev,target)>ev.count) return false; }
    return true;
  }
  function occurrenceOrdinal(ev,target){
    const startD=new Date(ev.startDate+'T00:00:00'); const interval=ev.interval||1; let n=0;
    if((ev.freq||'weekly')==='weekly'){
      const ws=startOfWeek(startD); let w=new Date(ws); let guard=0;
      while(w<=target&&guard++<5000){
        const wi=Math.round((w-ws)/(7*86400000));
        if(wi%interval===0){
          for(const dow of ev.days.slice().sort((a,b)=>a-b)){
            const occ=new Date(w); occ.setDate(w.getDate()+dow);
            if(occ>=startD&&occ<=target) n++;
            if(sameDay(occ,target)) return n;
          }
        }
        w.setDate(w.getDate()+7);
      }
      return n;
    } else {
      for(let mi=0; mi<2000; mi++){
        const dt=new Date(startD.getFullYear(), startD.getMonth()+mi, 1);
        const occ=monthlyOccDate(ev,dt.getFullYear(),dt.getMonth());
        if(occ&&occ>=startD&&mi%interval===0){ n++; if(sameDay(occ,target)) return n; }
        if(occ&&occ>target) break;
        if(dt>target) break;
      }
      return n;
    }
  }

  // ---------- DOM ----------
  const content = $('#content');

  // ---------- Views ----------
  const VIEWS = {
    today:{title:'오늘', sub:'오늘 마감·예정된 행동', filter:t=>!isDone(t)&&(t.due===todayStr()||isOverdue(t.due)||(t.block&&t.block.date===todayStr()))},
    inbox:{title:'Inbox', sub:'수집함 — 분류가 필요한 항목', filter:t=>!isDone(t)&&t.status==='inbox'},
    next:{title:'다음 할일', sub:'바로 실행할 수 있는 일', filter:t=>!isDone(t)&&t.status==='next'},
    waiting:{title:'대기 중', sub:'다른 사람·조건을 기다리는 일', filter:t=>!isDone(t)&&t.status==='waiting'},
    someday:{title:'언젠가 / 보류', sub:'지금은 아니지만 잊지 않을 일', filter:t=>!isDone(t)&&t.status==='someday'},
    done:{title:'완료', sub:'최근 완료한 일', filter:t=>isDone(t)},
  };

  function countFor(fn){ return state.tasks.filter(fn).length; }

  // 다음 실행 시 복원할 화면(필터 뷰·설정 제외)
  const RESTORABLE_VIEWS = new Set(['today','suggest','plan','pomodoro','gtdboard','inbox','next','waiting','someday','done','review','weekreview']);
  function setView(v, filter=null){
    currentView=v; currentFilter=filter;
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active', n.dataset.view===v && !filter));
    if(!filter && RESTORABLE_VIEWS.has(v)) localStorage.setItem('flowdo.lastview', v);
    closeSidebar();
    render();
  }

  // ---------- Render ----------
  function render(){
    renderSidebarCounts();
    renderProjectNav();
    renderTagNav();
    if(currentView==='plan'){ renderPlan(); return; }
    if(currentView==='pomodoro'){ renderPomodoro(); return; }
    if(currentView==='suggest'){ renderSuggest(); return; }
    if(currentView==='review'){ renderReview(); return; }
    if(currentView==='weekreview'){ renderWeekReview(); return; }
    if(currentView==='gtdboard'){ renderGtdBoard(); return; }
    if(currentView==='settings'){ renderSettings(); return; }

    let tasks, title, sub;
    if(currentFilter){
      if(currentFilter.type==='project'){
        const p=state.projects.find(x=>x.id===currentFilter.value);
        title=p?p.name:'프로젝트'; sub='이 프로젝트의 할 일';
        tasks=state.tasks.filter(t=>t.projectId===currentFilter.value);
      } else {
        title='#'+currentFilter.value; sub='이 태그가 달린 할 일';
        tasks=state.tasks.filter(t=>(t.tags||[]).includes(currentFilter.value));
      }
    } else {
      const v=VIEWS[currentView]; title=v.title; sub=v.sub;
      tasks=state.tasks.filter(v.filter);
    }
    $('#viewTitle').textContent=title;
    $('#viewSub').textContent=sub;

    tasks=sortTasks(tasks);
    content.innerHTML='';
    const qa=quickAddBar();
    content.appendChild(qa);

    if(!tasks.length){
      content.appendChild(el(`<div class="empty"><img class="brand-logo" src="icons/teum-logo-horizontal.svg" alt="TEUM" />할 일이 없습니다. 위에 입력해 추가하세요.</div>`));
      return;
    }
    const list=el('<div class="tasklist"></div>');
    tasks.forEach(t=>list.appendChild(taskRow(t)));
    content.appendChild(list);
  }

  // sortTasks·추천점수·describeEvent·isPastEvent·설치헬퍼는 logic.js로 분리됨

  // ---------- GTD 보드 (칸반: Inbox·다음행동·대기·언젠가) ----------
  const GTD_COLS=[
    {status:'inbox', title:'Inbox', ico:'📥'},
    {status:'next', title:'다음 할일', ico:'⚡'},
    {status:'waiting', title:'대기 중', ico:'⏳'},
    {status:'someday', title:'언젠가', ico:'💭'},
  ];
  function gtdCard(t){
    const pc=t.priority<=3?`p${t.priority}`:'';
    const card=el(`<div class="gtdb-card ${isOverdue(t.due)?'overdue':''}" draggable="true">
      <div class="gc-title"><span class="pt-dot ${pc}"></span><span class="gc-t">${esc(t.title)}</span>${subBadgeHTML(t)}</div>
      <div class="gc-meta"></div>
    </div>`);
    const meta=card.querySelector('.gc-meta');
    if(t.due) meta.appendChild(el(`<span class="chip due ${isOverdue(t.due)?'overdue':''}">📅 ${fmtDue(t.due)}${t.dueTime?' '+t.dueTime:''}</span>`));
    if(t.projectId){ const p=state.projects.find(x=>x.id===t.projectId); if(p) meta.appendChild(el(`<span class="chip"><span class="proj-color" style="background:${p.color}"></span>${esc(p.name)}</span>`)); }
    (t.tags||[]).slice(0,2).forEach(tag=>meta.appendChild(el(`<span class="chip tag">${esc(tag)}</span>`)));
    card.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);card.classList.add('dragging');});
    card.addEventListener('dragend',()=>card.classList.remove('dragging'));
    card.querySelector('.gc-title').addEventListener('click',()=>openTask(t.id));
    return card;
  }
  function renderGtdBoard(){
    $('#viewTitle').textContent='GTD 보드';
    $('#viewSub').textContent='수집함을 분류하고 다음 할일을 정리하세요';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='gtdboard'));
    content.innerHTML='';
    const board=el(`<div class="gtdb"></div>`);
    GTD_COLS.forEach(col=>{
      const tasks=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.status===col.status));
      const c=el(`<div class="gtdb-col">
        <div class="gtdb-head"><span>${col.ico} ${col.title}</span><span class="count">${tasks.length||''}</span></div>
        <div class="quickadd gtdb-add"><span>＋</span><input placeholder="빠른 추가" /></div>
        <div class="gtdb-cards"></div>
      </div>`);
      const cards=c.querySelector('.gtdb-cards');
      if(!tasks.length) cards.appendChild(el(`<div class="note" style="padding:8px 2px">비어 있음</div>`));
      tasks.forEach(t=>cards.appendChild(gtdCard(t)));
      const inp=c.querySelector('input');
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter'&&inp.value.trim()){ quickAdd(inp.value.trim(), col.status); inp.value=''; renderGtdBoard(); } });
      // 카드 드롭 → 상태 변경
      c.addEventListener('dragover',e=>{e.preventDefault();c.classList.add('gtdb-drop');});
      c.addEventListener('dragleave',e=>{ if(e.target===c) c.classList.remove('gtdb-drop'); });
      c.addEventListener('drop',e=>{e.preventDefault();c.classList.remove('gtdb-drop');
        const id=e.dataTransfer.getData('text/plain'); const t=state.tasks.find(x=>x.id===id);
        if(t && (t.status!==col.status || isDone(t))){ if(isDone(t)) t.completedAt=null; t.status=col.status; t.updatedAt=Date.now(); save(); renderGtdBoard(); renderSidebarCounts(); }
      });
      board.appendChild(c);
    });
    content.appendChild(board);
  }

  function quickAddBar(){
    const bar=el(`<div class="quickadd">
      <span>➕</span>
      <input id="quickInput" placeholder="빠른 추가 —  예) 보고서 작성 !1 @연구 #논문 투고 오늘" />
      <span class="hint">!우선순위 · @태그 · #프로젝트 · 오늘/내일</span>
    </div>`);
    const input=bar.querySelector('#quickInput');
    input.addEventListener('keydown', e=>{ if(e.key==='Enter' && input.value.trim()){ quickAdd(input.value.trim()); input.value=''; } });
    return bar;
  }

  function quickAdd(raw, forceStatus){
    let title=raw, priority=4, tags=[], projectId='', due=null, status= forceStatus || (currentView==='inbox'?'inbox':'next');
    // priority !1..!4
    title=title.replace(/!([1-4])/g,(m,p)=>{priority=+p;return '';});
    // tags @x
    title=title.replace(/@(\S+)/g,(m,t)=>{tags.push('@'+t);return '';});
    // project #name (rest of token, allow spaces if matches existing)
    const pm=title.match(/#([^\n!]+)$/);
    if(pm){ const name=pm[1].trim(); const p=state.projects.find(x=>x.name.toLowerCase()===name.toLowerCase()); if(p){projectId=p.id; title=title.replace(pm[0],'');} }
    // dates
    if(/오늘/.test(title)){ due=todayStr(); title=title.replace(/오늘/,''); }
    else if(/내일/.test(title)){ const d=new Date(); d.setDate(d.getDate()+1); due=todayStr(d); title=title.replace(/내일/,''); }
    title=title.replace(/\s+/g,' ').trim();
    if(!title) return;
    // contextual defaults from current view (forceStatus가 있으면 그것 우선)
    if(!forceStatus){
      if(currentView==='waiting') status='waiting';
      if(currentView==='someday') status='someday';
    }
    if(currentView==='today' && !due) due=todayStr();
    if(currentFilter&&currentFilter.type==='project') projectId=currentFilter.value;
    if(currentFilter&&currentFilter.type==='tag') tags.push(currentFilter.value);
    state.tasks.push({id:uid(),title,notes:'',status,priority,tags:[...new Set(tags)],projectId,due,block:null,createdAt:Date.now(),updatedAt:Date.now(),completedAt:null});
    save(); render();
  }

  function taskRow(t){
    const pc = t.priority<=3?`p${t.priority}`:'';
    const node=el(`<div class="task ${isDone(t)?'done':''}" draggable="true">
      <button class="check ${pc}">${isDone(t)?'✓':''}</button>
      <div class="task-body">
        <div class="task-title"></div>
        <div class="task-meta"></div>
      </div>
      <div class="task-actions">
        <button class="iconbtn" data-act="pomo" title="뽀모도로 시작">🍅</button>
        <button class="iconbtn" data-act="edit" title="편집">✏️</button>
        <button class="iconbtn" data-act="del" title="삭제">🗑️</button>
      </div>
    </div>`);
    node.querySelector('.task-title').textContent=t.title;
    const sb=subBadgeEl(t); if(sb) node.querySelector('.task-title').appendChild(sb);
    const meta=node.querySelector('.task-meta');
    if(t.projectId){ const p=state.projects.find(x=>x.id===t.projectId); if(p) meta.appendChild(el(`<span class="chip"><span class="proj-color" style="background:${p.color}"></span>${esc(p.name)}</span>`)); }
    if(t.due){ const ov=isOverdue(t.due); meta.appendChild(el(`<span class="chip due ${ov?'overdue':''}">📅 ${fmtDue(t.due)}${t.dueTime?' '+t.dueTime:''}</span>`)); }
    if(t.block){ meta.appendChild(el(`<span class="chip block">🗓️ ${t.block.date===todayStr()?'오늘 ':''}${minToHHMM(t.block.start)}</span>`)); }
    if(t.estimate){ meta.appendChild(el(`<span class="chip">⏱ ${t.estimate}분</span>`)); }
    const sc=sessionsForTask(t.id); if(sc) meta.appendChild(el(`<span class="chip pomo">🍅 ${sc}</span>`));
    (t.tags||[]).forEach(tag=>{ const c=el(`<span class="chip tag">${esc(tag)}</span>`); c.addEventListener('click',e=>{e.stopPropagation();setView('tag',{type:'tag',value:tag});}); meta.appendChild(c); });

    node.querySelector('.check').addEventListener('click',e=>{e.stopPropagation();toggleDone(t.id);});
    node.querySelector('[data-act="pomo"]').addEventListener('click',e=>{e.stopPropagation();startPomoForTask(t.id);});
    node.querySelector('[data-act="edit"]').addEventListener('click',e=>{e.stopPropagation();openTask(t.id);});
    node.querySelector('[data-act="del"]').addEventListener('click',e=>{e.stopPropagation();delTask(t.id);});
    node.querySelector('.task-title').addEventListener('click',()=>openTask(t.id));
    // drag to schedule
    node.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);node.classList.add('dragging');});
    node.addEventListener('dragend',()=>node.classList.remove('dragging'));
    return node;
  }

  function toggleDone(id){
    const t=state.tasks.find(x=>x.id===id); if(!t) return;
    if(isDone(t)){ t.status = t._prev||'next'; t.completedAt=null; }
    else { t._prev=t.status; t.status='done'; t.completedAt=Date.now(); }
    t.updatedAt=Date.now(); save(); render();
  }
  function delTask(id){
    state.tasks=state.tasks.filter(x=>x.id!==id); save(); render();
  }

  // ---------- Time-box (Plan) view ----------
  let planDate = todayStr();
  let planView = (function(){ const v=localStorage.getItem('flowdo.planview'); return (v==='week'||v==='month')?v:'day'; })();
  let planTimer = null;
  function setPlanView(v){ planView=v; localStorage.setItem('flowdo.planview',v); renderPlan(); }
  function planNav(dir){ // dir: -1 이전 / +1 다음
    if(planView==='month') planDate=addMonthsDS(planDate.slice(0,8)+'01', dir);
    else if(planView==='week') planDate=addDaysDS(planDate, dir*7);
    else planDate=addDaysDS(planDate, dir);
    miniMonth=planDate.slice(0,8)+'01'; renderPlan();
  }

  function renderPlan(){
    $('#viewTitle').textContent='타임박스';
    $('#viewSub').textContent='왼쪽 할 일을 오른쪽 시간표로 끌어다 놓아 하루를 설계하세요';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='plan'));
    if(planTimer){ clearInterval(planTimer); planTimer=null; }
    content.innerHTML='';
    const wrap=el(`<div class="tb">
      <div class="tb-left">
        <div class="tb-card"><div id="miniCal"></div></div>
        <div class="tb-card">
          <div class="tb-h"><span>🎯 오늘의 우선순위 TOP 3</span></div>
          <div id="top3"></div>
        </div>
        <div class="tb-card">
          <div class="tb-h"><span>🧠 할 일</span><span id="poolCount" style="text-transform:none;font-weight:600"></span></div>
          <div class="quickadd" style="margin-bottom:10px">
            <span>➕</span>
            <input id="poolQuick" placeholder="빠른 추가 — 예) 자료 정리 !1 @연구" />
          </div>
          <div id="pool"></div>
        </div>
        <div class="tb-card">
          <div class="tb-h"><span>📅 일정</span><span style="display:flex;gap:6px"><button class="btn sm" id="addEventBtn">＋ 정기</button><button class="btn sm" id="addEventOnceBtn">＋ 일반</button></span></div>
          <div id="eventList"></div>
        </div>
      </div>
      <div class="tb-right">
        <div class="cal-top" id="calTop"></div>
        <div class="cal-body" id="calBody"></div>
      </div>
    </div>`);
    content.appendChild(wrap);
    const pq=wrap.querySelector('#poolQuick');
    pq.addEventListener('keydown',e=>{ if(e.key==='Enter'&&pq.value.trim()){ quickAdd(pq.value.trim()); pq.value=''; renderPlan(); } });
    wrap.querySelector('#addEventBtn').onclick=()=>openEvent(null,'weekly');
    wrap.querySelector('#addEventOnceBtn').onclick=()=>openEvent(null,'once');
    renderMiniCal();
    renderTop3();
    renderPool();
    renderEventList();
    renderCalTop();
    renderCalBody();
  }

  // ---- 캘린더 상단: 네비 + 일/주/월 토글 ----
  function calRangeLabel(){
    const d=parseDS(planDate);
    if(planView==='month') return `${d.getFullYear()}년 ${d.getMonth()+1}월`;
    if(planView==='week'){ const s=parseDS(startOfWeekDS(planDate)); const e=new Date(s); e.setDate(s.getDate()+6);
      const sameM=s.getMonth()===e.getMonth();
      return `${s.getMonth()+1}월 ${s.getDate()}일 – ${sameM?'':(e.getMonth()+1)+'월 '}${e.getDate()}일`; }
    return `${d.getMonth()+1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  }
  function renderCalTop(){
    const top=$('#calTop'); if(!top) return; top.innerHTML='';
    const bar=el(`<div class="cal-nav">
      <button class="iconbtn cal-arrow" id="cal-prev" title="이전">‹</button>
      <button class="btn sm" id="cal-today">오늘</button>
      <button class="iconbtn cal-arrow" id="cal-next" title="다음">›</button>
      <span class="cal-range">${esc(calRangeLabel())}</span>
      <div class="seg" role="tablist">
        <button data-v="day" class="${planView==='day'?'on':''}">일간</button>
        <button data-v="week" class="${planView==='week'?'on':''}">주간</button>
        <button data-v="month" class="${planView==='month'?'on':''}">월간</button>
      </div>
    </div>`);
    bar.querySelector('#cal-prev').onclick=()=>planNav(-1);
    bar.querySelector('#cal-next').onclick=()=>planNav(1);
    bar.querySelector('#cal-today').onclick=()=>{ planDate=todayStr(); miniMonth=planDate.slice(0,8)+'01'; renderPlan(); };
    bar.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>setPlanView(b.dataset.v));
    top.appendChild(bar);
  }
  function renderCalBody(){
    const body=$('#calBody'); if(!body) return; body.innerHTML='';
    if(planView==='week') renderWeek(body);
    else if(planView==='month') renderMonth(body);
    else renderDay(body);
  }
  function renderDay(body){
    CAL_START = dayExpanded ? 0 : 8;
    const wrap=el(`<div class="day-wrap">
      <button class="early-toggle">${dayExpanded?'▴ 새벽 시간 접기 (00–08시)':'▾ 새벽 시간 보기 (00–08시)'}</button>
    </div>`);
    wrap.querySelector('.early-toggle').onclick=()=>{ dayExpanded=!dayExpanded; renderCalBody(); };
    // 종일·기간 일정 스트립
    const allday=(state.events||[]).filter(ev=>ev.allDay&&eventOccursOn(ev,planDate));
    if(allday.length){ const strip=el(`<div class="day-allday"></div>`); allday.forEach(ev=>strip.appendChild(evAllDayChip(ev))); wrap.appendChild(strip); }
    wrap.appendChild(el(`<div class="calendar"><div class="cal-grid" id="calGrid"></div></div>`));
    body.appendChild(wrap);
    renderCalendar();
    startNowLine();
  }
  // 종일/기간 일정 칩 (일간 상단 스트립용)
  function evAllDayChip(ev){
    const chip=el(`<div class="ad-chip" style="background:${ev.color||'#0d9488'}" title="${esc(ev.title)}">${esc(ev.title)}</div>`);
    chip.addEventListener('click',e=>{e.stopPropagation();openEvent(ev.id);});
    return chip;
  }
  // ---- 연속 배너 레이아웃 (여러 날 종일 일정을 칸을 이어 표시) ----
  const BANNER_H=22; // 배너 한 레인 높이(px)
  function layoutBanners(days, events){
    // days: 'YYYY-MM-DD' 배열(연속). allDay 일정만 배너 대상.
    const cand=events.filter(ev=>ev.allDay && days.some(ds=>eventOccursOn(ev,ds)))
      .sort((a,b)=> (a.startDate||'').localeCompare(b.startDate||'') || (b.endDate||b.startDate||'').localeCompare(a.endDate||a.startDate||''));
    const laneEnd=[]; const placed=[];
    cand.forEach(ev=>{
      let s=-1,e=-1; days.forEach((ds,i)=>{ if(eventOccursOn(ev,ds)){ if(s<0)s=i; e=i; } });
      if(s<0) return;
      let lane=0; while(laneEnd[lane]!=null && laneEnd[lane]>=s) lane++;
      laneEnd[lane]=e;
      placed.push({ev,s,e,lane, contL: ev.startDate<days[s], contR:(ev.endDate||ev.startDate)>days[e]});
    });
    return {placed, lanes:laneEnd.length};
  }
  function bannerEl(p,total,cls,laneH,topBase){
    laneH=laneH||BANNER_H; topBase=topBase||0;
    const {ev,s,e,lane,contL,contR}=p;
    const left=s/total*100, width=(e-s+1)/total*100;
    const b=el(`<div class="ev-banner ${cls}" title="${esc(ev.title)}" style="left:${left}%;width:${width}%;top:${topBase+lane*laneH}px;background:${ev.color||'#0d9488'};${contL?'border-top-left-radius:0;border-bottom-left-radius:0;':''}${contR?'border-top-right-radius:0;border-bottom-right-radius:0;':''}">${contL?'‹ ':''}${esc(ev.title)}${contR?' ›':''}</div>`);
    b.addEventListener('click',ev2=>{ev2.stopPropagation();openEvent(ev.id);});
    return b;
  }
  function weekBanner(p,total){ return bannerEl(p,total,'wk-banner',BANNER_H,0); }

  // ---- 주간 보기: 7열 시간 그리드 ----
  function renderWeek(body){
    CAL_START = dayExpanded ? 0 : 8;
    const ws=startOfWeekDS(planDate);
    const days=[]; for(let i=0;i<7;i++) days.push(addDaysDS(ws,i));
    const today=todayStr();
    const gridH=(CAL_END-CAL_START)*60*PX_PER_MIN;
    const wrap=el(`<div class="day-wrap">
      <button class="early-toggle">${dayExpanded?'▴ 새벽 시간 접기 (00–08시)':'▾ 새벽 시간 보기 (00–08시)'}</button>
    </div>`);
    wrap.querySelector('.early-toggle').onclick=()=>{ dayExpanded=!dayExpanded; renderCalBody(); };
    const wk=el(`<div class="wk">
      <div class="wk-head"><div class="wk-gutter"></div><div class="wk-heads"></div></div>
      <div class="wk-allday"><div class="wk-gutter">일정</div><div class="wk-ad-main"><div class="wk-ad-banners"></div><div class="wk-ad-cols"></div></div></div>
      <div class="wk-scroll"><div class="wk-grid"><div class="wk-times"></div><div class="wk-cols"></div></div></div>
    </div>`);
    const heads=wk.querySelector('.wk-heads'), adcols=wk.querySelector('.wk-ad-cols'),
          banners=wk.querySelector('.wk-ad-banners'),
          times=wk.querySelector('.wk-times'), cols=wk.querySelector('.wk-cols');
    // 요일 헤더
    days.forEach(ds=>{ const d=parseDS(ds);
      const h=el(`<div class="wk-dh ${ds===today?'today':''} ${ds===planDate?'sel':''}"><span class="dow">${DOW[d.getDay()]}</span><span class="dom">${d.getDate()}</span></div>`);
      h.onclick=()=>{ planDate=ds; setPlanView('day'); };
      heads.appendChild(h);
    });
    // 종일·기간 일정 → 여러 날을 잇는 연속 배너
    const bl=layoutBanners(days,(state.events||[]));
    banners.style.height=(bl.lanes*BANNER_H)+'px';
    bl.placed.forEach(p=>banners.appendChild(weekBanner(p,days.length)));
    // 그날 마감이고 시간 블록이 없는 할 일 칩
    days.forEach(ds=>{ const col=el(`<div class="wk-ad"></div>`);
      const items=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.status!=='someday'&&t.due===ds&&!(t.block&&t.block.date===ds)));
      items.slice(0,4).forEach(t=>{ const pc=t.priority<=3?`p${t.priority}`:'';
        const chip=el(`<div class="wk-chip ${isOverdue(t.due)?'overdue':''}" draggable="true" title="${esc(t.title)}"><span class="pt-dot ${pc}"></span>${esc(t.title)}</div>`);
        chip.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);});
        chip.addEventListener('click',()=>openTask(t.id));
        col.appendChild(chip);
      });
      if(items.length>4) col.appendChild(el(`<div class="wk-more">+${items.length-4}</div>`));
      makeDayDrop(col,ds);
      adcols.appendChild(col);
    });
    // 시간 눈금
    for(let h=CAL_START;h<CAL_END;h++) times.appendChild(el(`<div class="wk-tlabel" style="top:${minToTop(h*60)}px">${pad(h)}:00</div>`));
    // 7개 시간 열
    cols.style.height=gridH+'px';
    days.forEach(ds=>{
      const col=el(`<div class="wk-col ${ds===today?'today':''}" style="height:${gridH}px"></div>`);
      // 일정 (시간 있는 것만)
      (state.events||[]).filter(ev=>!ev.allDay&&eventOccursOn(ev,ds)).forEach(ev=>{
        const card=el(`<div class="wk-ev" style="top:${minToTop(ev.start)}px;height:${Math.max(SNAP_MIN,ev.duration)*PX_PER_MIN-2}px;border-left-color:${ev.color||'#0d9488'}"><span class="t">${minToHHMM(ev.start)}</span><span class="n">${esc(ev.title)}</span></div>`);
        card.onclick=()=>openEvent(ev.id); col.appendChild(card);
      });
      // 작업 블록
      state.tasks.filter(t=>t.block&&t.block.date===ds).forEach(t=>{
        const pc=t.priority<=2?`p${t.priority}`:'';
        const card=el(`<div class="wk-blk ${pc}" draggable="true" style="top:${minToTop(t.block.start)}px;height:${Math.max(SNAP_MIN,t.block.duration)*PX_PER_MIN-2}px"><span class="t">${minToHHMM(t.block.start)}</span><span class="n">${esc(t.title)}</span><div class="block-resize" title="드래그하여 길이 조절"></div></div>`);
        card.addEventListener('dragstart',e=>{ if(resizing){e.preventDefault();return;} e.dataTransfer.setData('text/plain',t.id); const r=card.getBoundingClientRect(); dragOffsetMin=snapMin((e.clientY-r.top)/PX_PER_MIN); });
        card.addEventListener('dragend',()=>{dragOffsetMin=0;});
        card.addEventListener('click',()=>openTask(t.id));
        initResize(card.querySelector('.block-resize'),card,t);
        col.appendChild(card);
      });
      // 현재 시각선
      if(ds===today){ const now=new Date(); const mins=now.getHours()*60+now.getMinutes();
        if(mins>=CAL_START*60&&mins<CAL_END*60) col.appendChild(el(`<div class="wk-now" style="top:${minToTop(mins)}px"></div>`)); }
      // 드롭 → 해당 요일·시각에 배치
      col.addEventListener('dragover',e=>{e.preventDefault();});
      col.addEventListener('drop',e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');if(!id)return;
        const r=col.getBoundingClientRect();
        let m=snapMin(CAL_START*60+(e.clientY-r.top)/PX_PER_MIN-dragOffsetMin);
        m=Math.max(CAL_START*60,Math.min(CAL_END*60-SNAP_MIN,m));
        scheduleTask(id,m,ds);
      });
      cols.appendChild(col);
    });
    wrap.appendChild(wk);
    body.appendChild(wrap);
    // 현재 시각 근처로 스크롤
    const sc=wk.querySelector('.wk-scroll');
    const now=new Date(); const mins=now.getHours()*60+now.getMinutes();
    if(mins>=CAL_START*60&&mins<CAL_END*60) sc.scrollTop=Math.max(0,minToTop(mins)-sc.clientHeight/2);
  }

  // ---- 월간 보기: 주별 행 + 연속 배너 + 셀 칩 ----
  const MB_H=17; // 월간 배너 레인 높이(px)
  function renderMonth(body){
    const first=parseDS(planDate.slice(0,8)+'01');
    const mo=first.getMonth();
    const gridStart=parseDS(startOfWeekDS(todayStr(first)));
    const today=todayStr();
    const grid=el(`<div class="mo"><div class="mo-dow"></div><div class="mo-weeks"></div></div>`);
    const dowRow=grid.querySelector('.mo-dow'), weeksHost=grid.querySelector('.mo-weeks');
    for(let i=0;i<7;i++) dowRow.appendChild(el(`<div class="mo-dn ${i===0?'sun':''} ${i===6?'sat':''}">${DOW[i]}</div>`));
    for(let w=0;w<6;w++){
      const wdays=[]; for(let i=0;i<7;i++){ const d=new Date(gridStart); d.setDate(gridStart.getDate()+w*7+i); wdays.push(todayStr(d)); }
      const bl=layoutBanners(wdays,(state.events||[]));
      const padTop=20+bl.lanes*MB_H;
      const week=el(`<div class="mo-week"><div class="mo-row"></div><div class="mo-banners"></div></div>`);
      const row=week.querySelector('.mo-row'), bHost=week.querySelector('.mo-banners');
      wdays.forEach(ds=>{
        const d=parseDS(ds); const out=d.getMonth()!==mo;
        const cell=el(`<div class="mo-cell ${out?'out':''} ${ds===today?'today':''} ${ds===planDate?'sel':''}" style="padding-top:${padTop}px">
          <div class="mo-d">${d.getDate()}</div><div class="mo-items"></div></div>`);
        const host=cell.querySelector('.mo-items');
        // 시간 있는 일반 일정(단발)만 칩으로 (종일·기간은 배너로 표시됨)
        const timedOnce=(state.events||[]).filter(ev=>ev.freq==='once'&&!ev.allDay&&eventOccursOn(ev,ds));
        timedOnce.forEach(ev=>host.appendChild(evAllDayChip(ev)));
        const items=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.status!=='someday'&&(t.due===ds||(t.block&&t.block.date===ds))));
        const room=Math.max(0,3-timedOnce.length);
        items.slice(0,room).forEach(t=>{ const pc=t.priority<=3?`p${t.priority}`:'';
          const chip=el(`<div class="mo-chip ${isOverdue(t.due)?'overdue':''}" draggable="true" title="${esc(t.title)}"><span class="pt-dot ${pc}"></span>${esc(t.title)}</div>`);
          chip.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);});
          chip.addEventListener('click',e=>{e.stopPropagation();openTask(t.id);});
          host.appendChild(chip);
        });
        if(items.length>room) host.appendChild(el(`<div class="mo-more">+${items.length-room}</div>`));
        const hasRecur=(state.events||[]).some(ev=>ev.freq!=='once'&&eventOccursOn(ev,ds));
        if(hasRecur) cell.querySelector('.mo-d').insertAdjacentHTML('afterbegin','<span class="mo-evdot">🔁</span> ');
        cell.onclick=()=>{ planDate=ds; setPlanView('day'); };
        makeDayDrop(cell,ds);
        row.appendChild(cell);
      });
      // 연속 배너 (날짜 숫자 아래 20px부터)
      bl.placed.forEach(p=>bHost.appendChild(bannerEl(p,7,'mo-banner',MB_H,20)));
      weeksHost.appendChild(week);
    }
    body.appendChild(grid);
  }

  // 날짜 칸/칩에 할 일 드롭 → 그날로 마감일(있으면 블록) 이동
  function makeDayDrop(elem,ds){
    elem.addEventListener('dragover',e=>{e.preventDefault();elem.classList.add('day-drop');});
    elem.addEventListener('dragleave',e=>{ if(e.target===elem) elem.classList.remove('day-drop'); });
    elem.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();elem.classList.remove('day-drop');
      const id=e.dataTransfer.getData('text/plain'); const t=state.tasks.find(x=>x.id===id); if(!t) return;
      t.due=ds; if(t.block) t.block.date=ds; t.updatedAt=Date.now(); save(); renderPlan();
    });
  }

  // -- TOP 3 priorities (per day) --
  function top3Map(){ if(!state.top3) state.top3={}; return state.top3; }
  function getTop3(){ return (top3Map()[planDate]||[null,null,null]).slice(0,3); }
  function setTop3Slot(i,id){
    const m=top3Map(); const arr=(m[planDate]||[null,null,null]).slice(0,3);
    for(let k=0;k<3;k++) if(arr[k]===id) arr[k]=null;
    arr[i]=id; m[planDate]=arr;
    const t=state.tasks.find(x=>x.id===id);
    if(t){ if(t.priority>2)t.priority=2; if(!t.due)t.due=planDate; t.updatedAt=Date.now(); }
    save(); renderPlan();
  }
  function clearTop3Slot(i){ const m=top3Map(); const arr=(m[planDate]||[null,null,null]).slice(0,3); arr[i]=null; m[planDate]=arr; save(); renderPlan(); }
  function renderTop3(){
    const box=$('#top3'); box.innerHTML=''; const arr=getTop3();
    for(let i=0;i<3;i++){
      const id=arr[i]; const t=id?state.tasks.find(x=>x.id===id):null;
      const slot=el(`<div class="top3-slot ${t?'filled':''}" ${t?'draggable="true"':''}>
        <span class="top3-num">${i+1}</span>
        <span class="t3-title">${t?esc(t.title):'여기로 끌어다 놓기'}</span>
        ${t?subBadgeHTML(t):''}
        ${t?'<button class="iconbtn" title="비우기">✕</button>':''}
      </div>`);
      if(t){ slot.querySelector('button').onclick=()=>clearTop3Slot(i); slot.querySelector('.t3-title').onclick=()=>openTask(t.id);
        slot.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);}); }
      slot.addEventListener('dragover',e=>{e.preventDefault();slot.classList.add('dragover');});
      slot.addEventListener('dragleave',()=>slot.classList.remove('dragover'));
      slot.addEventListener('drop',e=>{e.preventDefault();slot.classList.remove('dragover');const did=e.dataTransfer.getData('text/plain');if(did)setTop3Slot(i,did);});
      box.appendChild(slot);
    }
  }

  // -- Task pool (brain dump) --
  function renderPool(){
    const pool=$('#pool'); pool.innerHTML='';
    const top3ids=getTop3().filter(Boolean);
    const avail=state.tasks.filter(t=>!isDone(t)&&t.status!=='someday'&&(!t.block||t.block.date!==planDate)&&!top3ids.includes(t.id));
    $('#poolCount').textContent=avail.length?`${avail.length}개`:'';
    const overdue=avail.filter(t=>isOverdue(t.due));
    if(overdue.length){
      const banner=el(`<div class="overdue-banner"><span>⚠ 밀린 일정 ${overdue.length}개</span><button>오늘로 이월 →</button></div>`);
      banner.querySelector('button').onclick=()=>{ overdue.forEach(t=>{t.due=todayStr();t.updatedAt=Date.now();}); save(); renderPlan(); };
      pool.appendChild(banner);
    }
    const dated=sortTasks(avail.filter(t=>(t.due&&(isOverdue(t.due)||t.due===planDate))||(t.block&&t.block.date===planDate)));
    const undated=sortTasks(avail.filter(t=>!dated.includes(t)));
    addPoolGroup(pool, planDate===todayStr()?'오늘 할 일':'예정 할 일', dated);
    addPoolGroup(pool,'기본 할 일', undated);
    if(!avail.length) pool.appendChild(el(`<div class="note" style="padding:10px 2px">배치할 할 일이 없습니다. 위에서 추가하세요.</div>`));
    // 캘린더/TOP3 카드를 여기로 끌어다 놓으면 배치·우선순위 해제
    pool.ondragover=e=>{e.preventDefault();pool.classList.add('pool-dragover');};
    pool.ondragleave=e=>{ if(e.target===pool) pool.classList.remove('pool-dragover'); };
    pool.ondrop=e=>{e.preventDefault();pool.classList.remove('pool-dragover');unscheduleTo(e.dataTransfer.getData('text/plain'));};
  }
  function unscheduleTo(id){
    const t=state.tasks.find(x=>x.id===id); if(!t) return;
    let ch=false;
    if(t.block){ t.block=null; ch=true; }
    const arr=top3Map()[planDate];
    if(arr){ for(let k=0;k<arr.length;k++) if(arr[k]===id){ arr[k]=null; ch=true; } }
    if(ch){ t.updatedAt=Date.now(); save(); renderPlan(); }
  }
  function addPoolGroup(pool,label,list){
    if(!list.length) return;
    pool.appendChild(el(`<div class="pool-group-title">${label} <span style="color:var(--muted)">${list.length}</span></div>`));
    list.forEach(t=>{
      const pc=t.priority<=3?`p${t.priority}`:'';
      const card=el(`<div class="pool-task ${isOverdue(t.due)?'overdue':''}" draggable="true">
        <span class="pt-dot ${pc}"></span>
        <span class="pt-title">${esc(t.title)}</span>
        ${subBadgeHTML(t)}
        ${isOverdue(t.due)?'<span class="pt-badge">밀림</span>':''}
      </div>`);
      card.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);});
      card.querySelector('.pt-title').addEventListener('click',()=>openTask(t.id));
      pool.appendChild(card);
    });
  }

  // -- Day calendar (10분 단위 · 자유 드래그 이동 · 길이 조절 · 정기 일정 표시) --
  let CAL_START=8;                          // 일간: 기본 08시 시작(가변), 주간: 6시
  const CAL_END=24, SNAP_MIN=10, PX_PER_MIN=1; // 1분=1px, 10분 단위 스냅
  let dayExpanded=false;                     // 일간에서 새벽(00–08시) 펼침 여부
  let dragOffsetMin=0, resizing=false;
  function minToTop(min){ return (min-CAL_START*60)*PX_PER_MIN; }
  function snapMin(m){ return Math.round(m/SNAP_MIN)*SNAP_MIN; }
  function weekdayOf(ds){ return new Date(ds+'T00:00:00').getDay(); }

  function renderCalendar(){
    const grid=$('#calGrid'); grid.innerHTML='';
    grid.style.height=((CAL_END-CAL_START)*60*PX_PER_MIN)+'px';
    for(let h=CAL_START;h<=CAL_END;h++){
      const top=minToTop(h*60);
      grid.appendChild(el(`<div class="cal-line" style="top:${top}px"></div>`));
      if(h<CAL_END){
        grid.appendChild(el(`<div class="cal-hour-label" style="top:${top}px">${pad(h)}:00</div>`));
        grid.appendChild(el(`<div class="cal-line half" style="top:${top+30*PX_PER_MIN}px"></div>`));
      }
    }
    grid.addEventListener('dragover',e=>{e.preventDefault();showDropIndic(e);});
    grid.addEventListener('dragleave',e=>{ if(e.target===grid) hideDropIndic(); });
    grid.addEventListener('drop',e=>{e.preventDefault();hideDropIndic();const id=e.dataTransfer.getData('text/plain');if(id)scheduleTask(id,calMin(e));});
    // 일정 (정기 + 한 번) — 시간이 있는 것만 그리드에 표시 (종일은 상단 스트립)
    (state.events||[]).filter(ev=>!ev.allDay&&eventOccursOn(ev,planDate)).forEach(ev=>{
      const top=minToTop(ev.start), height=Math.max(SNAP_MIN, ev.duration)*PX_PER_MIN-2;
      const tag=ev.freq==='once'?'':'🔁 ';
      const card=el(`<div class="event-card" style="top:${top}px;height:${height}px;border-left-color:${ev.color||'#0d9488'}">
        <div class="bc-main"><span class="time">${tag}${minToHHMM(ev.start)}~${minToHHMM(ev.start+ev.duration)}</span><span class="bc-title">${esc(ev.title)}</span></div>
      </div>`);
      card.title=ev.title+' (일정 — 클릭하여 편집)';
      card.style.cursor='pointer';
      card.addEventListener('click',()=>openEvent(ev.id));
      grid.appendChild(card);
    });
    // 작업 블록
    state.tasks.filter(t=>t.block&&t.block.date===planDate).forEach(t=>{
      const top=minToTop(t.block.start), height=Math.max(SNAP_MIN, t.block.duration)*PX_PER_MIN-2;
      const pc=t.priority<=2?`p${t.priority}`:'';
      const card=el(`<div class="block-card ${pc}" draggable="true" style="top:${top}px;height:${height}px">
        <div class="bc-main"><span class="time">${minToHHMM(t.block.start)}~${minToHHMM(t.block.start+t.block.duration)}</span><span class="bc-title">${esc(t.title)}${subBadgeHTML(t)}</span></div>
        <button class="bc-x iconbtn" title="배치 해제">✕</button>
        <div class="block-resize" title="드래그하여 길이 조절"></div>
      </div>`);
      card.addEventListener('dragstart',e=>{ if(resizing){e.preventDefault();return;} e.dataTransfer.setData('text/plain',t.id); const r=card.getBoundingClientRect(); dragOffsetMin=snapMin((e.clientY-r.top)/PX_PER_MIN); });
      card.addEventListener('dragend',()=>{dragOffsetMin=0;});
      card.querySelector('.bc-x').onclick=e=>{e.stopPropagation();t.block=null;t.updatedAt=Date.now();save();renderPlan();};
      card.querySelector('.bc-main').addEventListener('click',()=>openTask(t.id));
      initResize(card.querySelector('.block-resize'),card,t);
      grid.appendChild(card);
    });
  }
  function calMin(e){
    const grid=$('#calGrid'); const rect=grid.getBoundingClientRect();
    let m=snapMin(CAL_START*60 + (e.clientY-rect.top)/PX_PER_MIN - dragOffsetMin);
    return Math.max(CAL_START*60, Math.min(CAL_END*60-SNAP_MIN, m));
  }
  function showDropIndic(e){
    const grid=$('#calGrid'); if(!grid) return;
    let ind=grid.querySelector('.drop-indic');
    if(!ind){ ind=el(`<div class="drop-indic"></div>`); grid.appendChild(ind); }
    const m=calMin(e); ind.style.top=minToTop(m)+'px'; ind.setAttribute('data-time',minToHHMM(m));
  }
  function hideDropIndic(){ const g=$('#calGrid'); const ind=g&&g.querySelector('.drop-indic'); if(ind) ind.remove(); }

  function initResize(handle,card,t){
    handle.addEventListener('pointerdown',e=>{
      e.preventDefault(); e.stopPropagation(); resizing=true;
      const startY=e.clientY, startH=card.offsetHeight+2;
      try{ handle.setPointerCapture(e.pointerId); }catch(_){}
      const move=ev=>{
        let dur=Math.max(SNAP_MIN, snapMin((startH+(ev.clientY-startY))/PX_PER_MIN));
        card.style.height=(dur*PX_PER_MIN-2)+'px';
        const tm=card.querySelector('.time'); if(tm) tm.textContent=`${minToHHMM(t.block.start)}~${minToHHMM(t.block.start+dur)}`;
      };
      const up=()=>{
        handle.removeEventListener('pointermove',move); handle.removeEventListener('pointerup',up);
        t.block.duration=Math.max(SNAP_MIN, snapMin((card.offsetHeight+2)/PX_PER_MIN));
        t.updatedAt=Date.now(); setTimeout(()=>{resizing=false;},0); save(); renderPlan();
      };
      handle.addEventListener('pointermove',move); handle.addEventListener('pointerup',up);
    });
  }

  function startNowLine(){
    if(planTimer){ clearInterval(planTimer); planTimer=null; }
    drawNowLine();
    // 현재 시각 근처로 자동 스크롤
    const grid=$('#calGrid'); const cal=grid&&grid.parentElement;
    if(cal&&planDate===todayStr()){
      const now=new Date(); const mins=now.getHours()*60+now.getMinutes();
      if(mins>=CAL_START*60&&mins<CAL_END*60) cal.scrollTop=Math.max(0, minToTop(mins)-cal.clientHeight/2);
    }
    planTimer=setInterval(()=>{ if(currentView!=='plan'){ clearInterval(planTimer); planTimer=null; return; } drawNowLine(); },30000);
  }
  function drawNowLine(){
    const grid=$('#calGrid'); if(!grid) return;
    const old=grid.querySelector('.now-line'); if(old) old.remove();
    if(planDate!==todayStr()) return;
    const now=new Date(); const mins=now.getHours()*60+now.getMinutes();
    if(mins<CAL_START*60||mins>=CAL_END*60) return;
    const line=el(`<div class="now-line" style="top:${minToTop(mins)}px"><span class="now-time">${pad(now.getHours())}:${pad(now.getMinutes())}</span></div>`);
    grid.appendChild(line);
  }

  function scheduleTask(id,min,date){
    date=date||planDate;
    const t=state.tasks.find(x=>x.id===id); if(!t) return;
    const dur=t.block?t.block.duration:(t.estimate||60);
    t.block={date:date,start:min,duration:dur};
    if(!t.due) t.due=date;
    t.updatedAt=Date.now(); save(); renderPlan();
  }

  // ---------- Pomodoro ----------
  function pomoLen(mode){ const s=state.settings; return (mode==='focus'?s.focus:mode==='short'?s.short:s.long)*60; }
  function renderPomodoro(){
    $('#viewTitle').textContent='뽀모도로';
    $('#viewSub').textContent='집중 25분 · 휴식 5분 — 할 일에 집중 세션을 쌓으세요';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='pomodoro'));
    content.innerHTML='';
    const s=state.settings;
    const active=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.status!=='someday'));
    const opts=active.map(t=>`<option value="${t.id}" ${t.id===pomo.taskId?'selected':''}>${esc(t.title)} ${sessionsForTask(t.id)?'🍅×'+sessionsForTask(t.id):''}</option>`).join('');
    const totalToday=todaySessions().length;
    const focusMin=todaySessions().reduce((a,b)=>a+(b.duration||0),0);
    const wrap=el(`<div class="pomo ${pomo.running?'pomo-running':''}">
      <div class="pomo-modes">
        <button data-m="focus" class="${pomo.mode==='focus'?'sel':''}">집중</button>
        <button data-m="short" class="${pomo.mode==='short'?'sel brk':''}">짧은 휴식</button>
        <button data-m="long" class="${pomo.mode==='long'?'sel brk':''}">긴 휴식</button>
      </div>
      <div class="pomo-dial">
        <svg viewBox="0 0 120 120" width="260" height="260">
          <circle cx="60" cy="60" r="54" fill="none" stroke="var(--border)" stroke-width="7"/>
          <circle id="pomoArc" cx="60" cy="60" r="54" fill="none" stroke="${pomo.mode==='focus'?'var(--accent)':'var(--green)'}" stroke-width="7" stroke-linecap="round" stroke-dasharray="339.3" stroke-dashoffset="0"/>
        </svg>
        <div style="text-align:center">
          <div class="pomo-time" id="pomoTime">00:00</div>
          <div class="pomo-state" id="pomoState"></div>
        </div>
      </div>
      <div class="pomo-controls">
        <button class="btn primary" id="pomoToggle">시작</button>
        <button class="btn" id="pomoReset">초기화</button>
        <button class="btn" id="pomoSkip">건너뛰기</button>
      </div>
      <div class="pomo-task">
        <div style="font-size:13px;color:var(--muted);font-weight:600">🎯 집중할 할 일</div>
        <select id="pomoTask"><option value="">— 선택 안 함 —</option>${opts}</select>
      </div>
      <div class="pomo-stats">
        <div class="pomo-stat"><div class="n">${totalToday}</div><div class="l">오늘 완료 뽀모도로</div></div>
        <div class="pomo-stat"><div class="n">${focusMin}</div><div class="l">오늘 집중(분)</div></div>
        <div class="pomo-stat"><div class="n">${pomo.cycle}</div><div class="l">이번 사이클</div></div>
      </div>
      <div class="pomo-settings">
        <label>집중<input type="number" id="set-focus" min="1" max="90" value="${s.focus}"></label>
        <label>짧은 휴식<input type="number" id="set-short" min="1" max="30" value="${s.short}"></label>
        <label>긴 휴식<input type="number" id="set-long" min="1" max="60" value="${s.long}"></label>
        <label>긴 휴식 주기<input type="number" id="set-every" min="2" max="8" value="${s.longEvery}"></label>
      </div>
    </div>`);
    content.appendChild(wrap);
    renderSidebarCounts();
    wrap.querySelectorAll('.pomo-modes button').forEach(b=>b.onclick=()=>switchMode(b.dataset.m,true));
    wrap.querySelector('#pomoToggle').onclick=togglePomo;
    wrap.querySelector('#pomoReset').onclick=()=>{ stopTick(); pomo.running=false; pomo.remaining=pomoLen(pomo.mode); paintPomo(); };
    wrap.querySelector('#pomoSkip').onclick=()=>completePhase(false);
    wrap.querySelector('#pomoTask').onchange=e=>pomo.taskId=e.target.value;
    ['focus','short','long','every'].forEach(k=>{
      const id={focus:'set-focus',short:'set-short',long:'set-long',every:'set-every'}[k];
      wrap.querySelector('#'+id).onchange=e=>{
        const v=Math.max(1,+e.target.value||1);
        if(k==='every') state.settings.longEvery=v; else state.settings[k]=v;
        save(); if(!pomo.running) pomo.remaining=pomoLen(pomo.mode); paintPomo();
      };
    });
    paintPomo();
  }
  function switchMode(m,manual){
    if(pomo.running && manual && !confirm('진행 중인 타이머를 멈추고 전환할까요?')) return;
    stopTick(); pomo.running=false; pomo.mode=m; pomo.remaining=pomoLen(m);
    if(currentView==='pomodoro') renderPomodoro(); else paintPomo();
  }
  function togglePomo(){
    if(pomo.running){ stopTick(); pomo.running=false; }
    else { pomo.running=true; startTick(); }
    paintPomo();
  }
  function startTick(){
    stopTick();
    pomo.interval=setInterval(()=>{
      pomo.remaining--;
      if(pomo.remaining<=0){ completePhase(true); }
      else paintPomo();
    },1000);
  }
  function stopTick(){ if(pomo.interval){ clearInterval(pomo.interval); pomo.interval=null; } }
  function completePhase(natural){
    stopTick();
    if(pomo.mode==='focus'){
      if(natural){ logSession(); pomo.cycle++; beep(2); }
      const longTime = pomo.cycle>0 && pomo.cycle % state.settings.longEvery===0;
      pomo.mode = longTime?'long':'short';
    } else {
      if(natural) beep(1);
      pomo.mode='focus';
    }
    pomo.remaining=pomoLen(pomo.mode);
    pomo.running=false;
    if(currentView==='pomodoro') renderPomodoro(); else paintPomo();
    if(natural && pomo.mode!=='focus') toast('집중 완료! 🍅 잠시 휴식하세요.');
    if(natural && notifyEnabled()){
      if(pomo.mode!=='focus') showNotify('🍅 집중 완료','잠시 휴식하세요.','teum-pomo');
      else showNotify('☕ 휴식 끝','다시 집중해볼까요?','teum-pomo');
    }
  }
  function logSession(){
    state.sessions.push({id:uid(),taskId:pomo.taskId||'',date:todayStr(),duration:state.settings.focus,at:Date.now()});
    save();
  }
  function paintPomo(){
    const mini=$('#pomoMini'), miniT=$('#pomoMiniTime');
    if(mini){ mini.style.display=pomo.running?'inline-flex':'none'; if(miniT) miniT.textContent=fmtClock(pomo.remaining); }
    if(currentView!=='pomodoro') return;
    const tEl=$('#pomoTime'); if(!tEl) return;
    tEl.textContent=fmtClock(pomo.remaining);
    const st=$('#pomoState');
    const taskName = pomo.taskId ? (state.tasks.find(t=>t.id===pomo.taskId)||{}).title : '';
    st.textContent = pomo.mode==='focus' ? (taskName?('🎯 '+taskName):'집중 시간') : (pomo.mode==='short'?'짧은 휴식':'긴 휴식');
    const arc=$('#pomoArc'); if(arc){ const total=pomoLen(pomo.mode); const frac=pomo.remaining/total; arc.style.strokeDashoffset=String(339.3*(1-frac)); }
    const tog=$('#pomoToggle'); if(tog){ tog.textContent=pomo.running?'일시정지':'시작'; }
    document.querySelector('.pomo')?.classList.toggle('pomo-running',pomo.running);
    $('#pomoMini') && ($('#pomoMini').style.display=pomo.running?'inline-flex':'none');
  }
  function fmtClock(sec){ sec=Math.max(0,sec); return `${pad(Math.floor(sec/60))}:${pad(sec%60)}`; }
  function beep(times){
    try{
      const ctx=new (window.AudioContext||window.webkitAudioContext)();
      let t=ctx.currentTime;
      for(let i=0;i<times;i++){
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.connect(g);g.connect(ctx.destination);o.frequency.value=880;o.type='sine';
        g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.3,t+.02);
        g.gain.exponentialRampToValueAtTime(.0001,t+.3);
        o.start(t);o.stop(t+.32);t+=.42;
      }
    }catch(e){}
  }
  function startPomoForTask(id){
    pomo.taskId=id; pomo.mode='focus'; pomo.remaining=pomoLen('focus');
    pomo.running=true; setView('pomodoro'); startTick(); paintPomo();
  }

  // -- Mini month calendar --
  let miniMonth = null; // 'YYYY-MM-01'
  function renderMiniCal(){
    const host=$('#miniCal'); if(!host) return;
    const base = miniMonth ? new Date(miniMonth+'T00:00:00') : new Date(planDate+'T00:00:00');
    const y=base.getFullYear(), m=base.getMonth();
    const startDow=new Date(y,m,1).getDay();
    const days=new Date(y,m+1,0).getDate();
    let html=`<div class="mc-head"><button class="iconbtn" id="mcPrev">‹</button><strong>${y}년 ${m+1}월</strong><button class="iconbtn" id="mcNext">›</button></div><div class="mc-grid">`;
    '일월화수목금토'.split('').forEach(d=>html+=`<div class="mc-dow">${d}</div>`);
    for(let i=0;i<startDow;i++) html+=`<div></div>`;
    for(let d=1;d<=days;d++){
      const ds=todayStr(new Date(y,m,d));
      const cls=['mc-day']; if(ds===planDate)cls.push('sel'); if(ds===todayStr())cls.push('today');
      html+=`<div class="${cls.join(' ')}" data-ds="${ds}">${d}${hasItems(ds)?'<span class="mc-dot"></span>':''}</div>`;
    }
    html+=`</div>`;
    host.innerHTML=html;
    host.querySelector('#mcPrev').onclick=()=>{ miniMonth=todayStr(new Date(y,m-1,1)); renderMiniCal(); };
    host.querySelector('#mcNext').onclick=()=>{ miniMonth=todayStr(new Date(y,m+1,1)); renderMiniCal(); };
    host.querySelectorAll('.mc-day').forEach(c=>c.onclick=()=>{ planDate=c.dataset.ds; miniMonth=todayStr(new Date(y,m,1)); renderPlan(); });
  }
  function hasItems(ds){
    if(state.tasks.some(t=>!isDone(t)&&((t.block&&t.block.date===ds)||t.due===ds))) return true;
    if((state.events||[]).some(ev=>eventOccursOn(ev,ds))) return true;
    return false;
  }

  // -- Recurring events --
  let evColor='#0d9488';
  let editingEventId=null;
  let showPastEvents=false;
  // describeEvent·isPastEvent → logic.js
  function renderEventList(){
    const host=$('#eventList'); if(!host) return; host.innerHTML='';
    const all=(state.events||[]).slice().sort((a,b)=>(a.startDate||'').localeCompare(b.startDate||'')||((a.start||0)-(b.start||0)));
    const past=all.filter(isPastEvent), current=all.filter(ev=>!isPastEvent(ev));
    if(!all.length){ host.appendChild(el(`<div class="note" style="padding:4px 2px">등록된 일정이 없습니다. 정기·일반(종일/기간) 일정을 추가하세요.</div>`)); return; }
    const addRow=ev=>{
      const row=el(`<div class="event-row ${isPastEvent(ev)?'past':''}">
        <span class="ev-color" style="background:${ev.color||'#0d9488'}"></span>
        <span class="ev-info" style="cursor:pointer"><b>${esc(ev.title)}</b><small>${esc(describeEvent(ev))}</small></span>
        <button class="iconbtn" title="삭제">✕</button></div>`);
      row.querySelector('.ev-info').onclick=()=>openEvent(ev.id);
      row.querySelector('button').onclick=()=>{ state.events=state.events.filter(x=>x.id!==ev.id); save(); renderPlan(); };
      host.appendChild(row);
    };
    if(!current.length && !showPastEvents) host.appendChild(el(`<div class="note" style="padding:4px 2px">예정된 일정이 없습니다.</div>`));
    current.forEach(addRow);
    if(past.length){
      const toggle=el(`<button class="btn sm" style="margin-top:6px;width:100%;color:var(--muted)">${showPastEvents?'지난 일정 숨기기':`지난 일정 ${past.length}개 보기`}</button>`);
      toggle.onclick=()=>{ showPastEvents=!showPastEvents; renderEventList(); };
      host.appendChild(toggle);
      if(showPastEvents) past.forEach(addRow);
    }
  }
  function updateEventModalVisibility(){
    const freq=$('#ev-freq').value, endMode=$('#ev-endmode').value, monthMode=$('#ev-monthmode').value;
    const once=freq==='once', allDay=$('#ev-allday').checked;
    // 한 번(종일·기간) 전용
    $('#ev-allday-field').style.display=once?'':'none';
    $('#ev-onceend-field').style.display=once?'':'none';
    $('#ev-time-row').style.display=(once&&allDay)?'none':'';
    $('#ev-startdate-label').textContent=once?'시작일 (또는 단일 날짜)':'시작일';
    // 정기 전용 (한 번이면 숨김)
    $('#ev-interval-field').style.display=once?'none':'';
    $('#ev-days-field').style.display=(!once&&freq==='weekly')?'':'none';
    $('#ev-monthmode-field').style.display=(!once&&freq==='monthly')?'':'none';
    $('#ev-monthweek-field').style.display=(!once&&freq==='monthly'&&monthMode==='weekday')?'':'none';
    $('#ev-endmode-field').style.display=once?'none':'';
    $('#ev-enddate-field').style.display=(!once&&endMode==='date')?'':'none';
    $('#ev-count-field').style.display=(!once&&endMode==='count')?'':'none';
    $('#ev-exholiday-field').style.display=once?'none':'';
    $('#ev-note').textContent=once?'기간 일정은 시작일~종료일의 모든 날에 표시됩니다. 종일이면 시간 없이 상단에 표시됩니다.'
      :"월 단위는 시작일의 '일(日)'에 반복됩니다. 캘린더·스케줄표에 자동 표시됩니다.";
  }
  function openEvent(id,presetFreq){
    editingEventId=(typeof id==='string')?id:null;
    const ev=editingEventId?(state.events||[]).find(x=>x.id===editingEventId):null;
    const freq=ev?(ev.freq||'weekly'):(presetFreq||'weekly');
    const once=freq==='once';
    $('#eventModalTitle').textContent=(ev?'편집 — ':'추가 — ')+(once?'📅 일반 일정':'🔁 정기 일정');
    $('#evDeleteBtn').style.display=ev?'':'none';
    $('#ev-title').value=ev?ev.title:'';
    $('#ev-allday').checked=ev?!!ev.allDay:false;
    $('#ev-start').value=(ev&&ev.start!=null)?minToHHMM(ev.start):'09:00';
    $('#ev-dur').value=(ev&&ev.duration!=null)?ev.duration:60;
    $('#ev-onceend').value=(ev&&once&&ev.endDate)?ev.endDate:'';
    $('#ev-freq').value=freq;
    $('#ev-interval').value=ev?String(ev.interval||1):'1';
    document.querySelectorAll('#evDays button').forEach(b=>b.classList.toggle('sel', ev&&ev.days?ev.days.includes(+b.dataset.d):false));
    const sd=ev?ev.startDate:planDate;
    $('#ev-monthmode').value=ev?(ev.monthMode||'date'):'date';
    $('#ev-ordinal').value=ev&&ev.ordinal!=null?String(ev.ordinal):String(Math.min(5,Math.ceil(new Date((sd)+'T00:00:00').getDate()/7)));
    $('#ev-weekday').value=ev&&ev.weekday!=null?String(ev.weekday):String(new Date((sd)+'T00:00:00').getDay());
    $('#ev-exholiday').checked=ev?!!ev.excludeHolidays:false;
    $('#ev-startdate').value=sd;
    $('#ev-endmode').value=ev?(ev.endMode||'never'):'never';
    $('#ev-enddate').value=ev&&ev.endDate?ev.endDate:'';
    $('#ev-count').value=ev&&ev.count?ev.count:10;
    evColor=ev?(ev.color||'#0d9488'):'#0d9488';
    const cw=$('#evColors'); cw.innerHTML='';
    PROJECT_COLORS.forEach(c=>{ const b=el(`<button type="button" style="background:${c};width:26px;height:26px;border-radius:50%;border:2px solid transparent"></button>`);
      b.onclick=()=>{evColor=c;document.querySelectorAll('#evColors button').forEach(x=>x.style.borderColor='transparent');b.style.borderColor=getComputedStyle(document.body).color;};
      if(c===evColor) b.style.borderColor=getComputedStyle(document.body).color;
      cw.appendChild(b); });
    updateEventModalVisibility();
    $('#eventOverlay').classList.add('show'); setTimeout(()=>$('#ev-title').focus(),50);
  }
  function saveEvent(){
    const title=$('#ev-title').value.trim(); if(!title){ $('#ev-title').focus(); return; }
    const freq=$('#ev-freq').value;
    if(freq==='once'){
      const allDay=$('#ev-allday').checked;
      const startDate=$('#ev-startdate').value||planDate;
      let endDate=$('#ev-onceend').value||startDate;
      if(endDate<startDate) endDate=startDate;
      let start=null,dur=null;
      if(!allDay){ start=hhmmToMin($('#ev-start').value); if(start==null){ alert('시작 시각을 입력하세요.'); return; } dur=Math.max(10,+($('#ev-dur').value)||60); }
      const data={title,freq:'once',allDay,startDate,endDate,start,duration:dur,color:evColor,
        days:[],interval:1,monthMode:undefined,ordinal:undefined,weekday:undefined,endMode:'never',count:null,excludeHolidays:false};
      if(!state.events) state.events=[];
      if(editingEventId){ const ex=state.events.find(x=>x.id===editingEventId); if(ex) Object.assign(ex,data); }
      else state.events.push({id:uid(),...data});
      save(); $('#eventOverlay').classList.remove('show'); renderPlan(); return;
    }
    const interval=Math.max(1,+$('#ev-interval').value||1);
    const days=[...document.querySelectorAll('#evDays button.sel')].map(b=>+b.dataset.d);
    if(freq==='weekly'&&!days.length){ alert('요일을 하나 이상 선택하세요.'); return; }
    const start=hhmmToMin($('#ev-start').value); if(start==null){ alert('시작 시각을 입력하세요.'); return; }
    const dur=Math.max(10,+($('#ev-dur').value)||60);
    const startDate=$('#ev-startdate').value||planDate;
    const endMode=$('#ev-endmode').value;
    const endDate=endMode==='date'?($('#ev-enddate').value||null):null;
    const count=endMode==='count'?Math.max(1,+$('#ev-count').value||1):null;
    if(endMode==='date'&&!endDate){ alert('종료일을 입력하세요.'); return; }
    const monthMode=$('#ev-monthmode').value;
    const data={title,start,duration:dur,freq,interval,allDay:false,days:freq==='weekly'?days:[],
      monthMode:freq==='monthly'?monthMode:undefined,
      ordinal:(freq==='monthly'&&monthMode==='weekday')?+$('#ev-ordinal').value:undefined,
      weekday:(freq==='monthly'&&monthMode==='weekday')?+$('#ev-weekday').value:undefined,
      startDate,endMode,endDate,count,excludeHolidays:$('#ev-exholiday').checked,color:evColor};
    if(!state.events) state.events=[];
    if(editingEventId){ const ev=state.events.find(x=>x.id===editingEventId); if(ev) Object.assign(ev,data); }
    else state.events.push({id:uid(),...data});
    save(); $('#eventOverlay').classList.remove('show'); renderPlan();
  }

  // ---------- Sidebar counts/nav ----------
  function renderSidebarCounts(){
    const set=(id,n)=>{ const e=$(id); if(e) e.textContent=n||''; };
    set('#c-today', countFor(VIEWS.today.filter));
    // GTD 보드: 처리 대기(inbox+다음행동+대기+언젠가) 합계
    set('#c-gtd', countFor(t=>!isDone(t)&&['inbox','next','waiting','someday'].includes(t.status)));
    set('#c-pomo', todaySessions().length);
  }
  function todaySessions(){ return (state.sessions||[]).filter(s=>s.date===todayStr()); }
  function sessionsForTask(id){ return (state.sessions||[]).filter(s=>s.taskId===id).length; }
  function renderProjectNav(){
    const nav=$('#projectNav'); nav.innerHTML='';
    state.projects.forEach(p=>{
      const open=countFor(t=>t.projectId===p.id&&!isDone(t));
      const b=el(`<button class="nav"><span class="proj-color" style="background:${p.color}"></span> ${esc(p.name)} <span class="count">${open||''}</span></button>`);
      b.classList.toggle('active',currentFilter&&currentFilter.type==='project'&&currentFilter.value===p.id);
      b.onclick=()=>setView('project',{type:'project',value:p.id});
      makeNavDrop(b,t=>{ t.projectId=p.id; });
      nav.appendChild(b);
    });
  }
  function renderTagNav(){
    const nav=$('#tagNav'); nav.innerHTML='';
    const tags=[...new Set(state.tasks.flatMap(t=>t.tags||[]))].sort();
    const sec=$('#tagSection'); if(sec) sec.style.display=tags.length?'':'none';
    if(!tags.length) return; // 태그 없으면 섹션 숨김
    tags.slice(0,12).forEach(tag=>{
      const b=el(`<button class="nav"><span class="ico">#</span> ${esc(tag)}</button>`);
      b.classList.toggle('active',currentFilter&&currentFilter.type==='tag'&&currentFilter.value===tag);
      b.onclick=()=>setView('tag',{type:'tag',value:tag});
      makeNavDrop(b,t=>{ if(!t.tags)t.tags=[]; if(!t.tags.includes(tag))t.tags.push(tag); });
      nav.appendChild(b);
    });
  }

  // ---------- Task modal ----------
  // 체크리스트 진행 배지 (예: ☑ 3/7) — 완료 시 초록
  function subProgress(t){
    const s=t&&t.subtasks||[]; if(!s.length) return null;
    const d=s.filter(x=>x.done).length;
    return {done:d, total:s.length, all:d===s.length};
  }
  function subBadgeEl(t){
    const p=subProgress(t); if(!p) return null;
    return el(`<span class="sub-badge ${p.all?'all':''}">☑ ${p.done}/${p.total}</span>`);
  }
  function subBadgeHTML(t){
    const p=subProgress(t); return p?`<span class="sub-badge ${p.all?'all':''}">☑ ${p.done}/${p.total}</span>`:'';
  }
  let editSubtasks=[]; // 모달에서 편집 중인 체크리스트
  function renderChecklistEditor(focusIdx){
    const host=$('#f-checklist'); if(!host) return; host.innerHTML='';
    editSubtasks.forEach((st,i)=>{
      const row=el(`<div class="cl-row">
        <button type="button" class="cl-check ${st.done?'on':''}">${st.done?'✓':''}</button>
        <input class="cl-input" value="${esc(st.title)}" placeholder="세부 항목" />
        <button type="button" class="iconbtn cl-del" title="삭제">✕</button>
      </div>`);
      row.querySelector('.cl-check').onclick=()=>{ st.done=!st.done; renderChecklistEditor(); };
      row.querySelector('.cl-input').addEventListener('input',e=>{ st.title=e.target.value; updateChecklistCount(); });
      row.querySelector('.cl-input').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); addSubtask(); } });
      row.querySelector('.cl-del').onclick=()=>{ editSubtasks.splice(i,1); renderChecklistEditor(); };
      host.appendChild(row);
    });
    updateChecklistCount();
    if(focusIdx!=null){ const inputs=host.querySelectorAll('.cl-input'); if(inputs[focusIdx]) inputs[focusIdx].focus(); }
  }
  function addSubtask(){ editSubtasks.push({id:uid(),title:'',done:false}); renderChecklistEditor(editSubtasks.length-1); }
  function updateChecklistCount(){
    const c=$('#f-checklist-count'); if(!c) return;
    const valid=editSubtasks.filter(s=>s.title.trim());
    c.textContent=valid.length?`${valid.filter(s=>s.done).length}/${valid.length}`:'';
  }
  function openTask(id){
    editingId=id;
    const t=id?state.tasks.find(x=>x.id===id):null;
    $('#taskModalTitle').textContent=id?'할 일 편집':'새 할 일';
    $('#taskDeleteBtn').style.display=id?'':'none';
    $('#f-title').value=t?t.title:'';
    $('#f-notes').value=t?t.notes:'';
    editSubtasks=(t&&Array.isArray(t.subtasks))?t.subtasks.map(s=>({id:s.id||uid(),title:s.title||'',done:!!s.done})):[];
    renderChecklistEditor();
    $('#f-status').value=t?t.status==='done'?(t._prev||'next'):t.status:(currentView==='inbox'?'inbox':'next');
    fillProjectSelect(t?t.projectId:(currentFilter&&currentFilter.type==='project'?currentFilter.value:''));
    $('#f-due').value=t?t.due||'':(currentView==='today'?todayStr():'');
    $('#f-duetime').value=t?t.dueTime||'':'';
    $('#f-tags').value=t?(t.tags||[]).join(', '):(currentFilter&&currentFilter.type==='tag'?currentFilter.value:'');
    $('#f-estimate').value=t?(t.estimate||''):'';
    setPrio(t?t.priority:4);
    $('#f-blockdate').value=t&&t.block?t.block.date:'';
    $('#f-blockstart').value=t&&t.block?minToHHMM(t.block.start):'';
    $('#f-blockdur').value=t&&t.block?t.block.duration:'';
    $('#taskOverlay').classList.add('show');
    setTimeout(()=>$('#f-title').focus(),50);
  }
  function closeTask(){ $('#taskOverlay').classList.remove('show'); editingId=null; }
  function fillProjectSelect(sel){
    const s=$('#f-project'); s.innerHTML='<option value="">없음</option>';
    state.projects.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;if(p.id===sel)o.selected=true;s.appendChild(o);});
  }
  function setPrio(p){ selectedPrio=p; document.querySelectorAll('#prioPick button').forEach(b=>b.classList.toggle('sel',+b.dataset.p===p)); }
  function saveTask(){
    const title=$('#f-title').value.trim(); if(!title){ $('#f-title').focus(); return; }
    const tags=$('#f-tags').value.split(',').map(s=>s.trim()).filter(Boolean);
    let block=null;
    const bd=$('#f-blockdate').value, bs=$('#f-blockstart').value;
    if(bd&&bs){ block={date:bd,start:hhmmToMin(bs),duration:+($('#f-blockdur').value)||60}; }
    const due=$('#f-due').value||null;
    const subtasks=editSubtasks.filter(s=>s.title.trim()).map(s=>({id:s.id,title:s.title.trim(),done:!!s.done}));
    const data={title,notes:$('#f-notes').value.trim(),status:$('#f-status').value,
      projectId:$('#f-project').value,due,dueTime:due?($('#f-duetime').value||null):null,tags,priority:selectedPrio,
      estimate:(+$('#f-estimate').value||null),block,subtasks};
    if(editingId){ const t=state.tasks.find(x=>x.id===editingId); Object.assign(t,data); t.updatedAt=Date.now(); }
    else { state.tasks.push({id:uid(),...data,createdAt:Date.now(),updatedAt:Date.now(),completedAt:null}); }
    save(); closeTask(); render();
  }

  // ---------- Project modal ----------
  function openProject(){
    $('#p-name').value=''; projColor=PROJECT_COLORS[0];
    const wrap=$('#projColors'); wrap.innerHTML='';
    PROJECT_COLORS.forEach(c=>{const b=el(`<button style="background:${c};flex:0 0 28px;height:28px;border-radius:50%;border:2px solid transparent"></button>`);
      b.onclick=()=>{projColor=c;document.querySelectorAll('#projColors button').forEach(x=>x.style.borderColor='transparent');b.style.borderColor=getComputedStyle(document.body).color;};
      if(c===projColor) b.style.borderColor=getComputedStyle(document.body).color;
      wrap.appendChild(b);});
    $('#projOverlay').classList.add('show');
    setTimeout(()=>$('#p-name').focus(),50);
  }
  function saveProject(){
    const name=$('#p-name').value.trim(); if(!name) return;
    state.projects.push({id:uid(),name,color:projColor}); save();
    $('#projOverlay').classList.remove('show'); render();
  }

  // ---------- 알림 (포그라운드 — 앱이 켜져 있을 때) ----------
  const notified = new Set();   // 이번 세션에 이미 띄운 알림 키 (중복 방지)
  let notifyTimer = null;
  function notifySupported(){ return typeof window!=='undefined' && 'Notification' in window; }
  function notifyEnabled(){ return !!(state.settings&&state.settings.notify) && notifySupported() && Notification.permission==='granted'; }
  function showNotify(title, body, tag){
    if(!notifySupported() || Notification.permission!=='granted') return false;
    const opts={ body, tag, icon:'icons/icon-192.png', badge:'icons/icon-192.png', renotify:true };
    const viaCtor=()=>{ try{ new Notification(title,opts); }catch(_){} };
    try{
      if(navigator.serviceWorker && navigator.serviceWorker.ready){
        let done=false;
        navigator.serviceWorker.ready.then(reg=>{ done=true; return reg.showNotification(title,opts); }).catch(viaCtor);
        setTimeout(()=>{ if(!done) viaCtor(); }, 700); // SW가 늦으면 직접 발송 폴백
      } else { viaCtor(); }
    }catch(_){ viaCtor(); }
    return true;
  }
  async function enableNotifications(){
    if(!notifySupported()){ alert('이 브라우저는 알림을 지원하지 않습니다.'); return false; }
    let perm=Notification.permission;
    if(perm==='default') perm=await Notification.requestPermission();
    if(perm!=='granted'){ alert('브라우저에서 알림이 차단되어 있습니다. 사이트 권한에서 허용해 주세요.'); return false; }
    return true;
  }
  function checkReminders(){
    if(!notifyEnabled()) return;
    const today=todayStr();
    const now=new Date(); const nm=now.getHours()*60+now.getMinutes();
    const lead=(state.settings.notifyLead!=null?state.settings.notifyLead:5);
    // 트리거 시각이 막 지난 것만(2분 창) 발송 → 앱 켤 때 과거 알림 폭주 방지
    const fire=(key,trigger,title,body)=>{ if(notified.has(key)) return; if(nm>=trigger && nm-trigger<2){ notified.add(key); showNotify(title,body,key); } };
    state.tasks.forEach(t=>{
      if(isDone(t)) return;
      if(t.block && t.block.date===today)
        fire('blk:'+t.id+':'+today+':'+t.block.start, t.block.start-lead, '⏰ 곧 시작: '+t.title, `${minToHHMM(t.block.start)} 시작 예정`);
      if(t.due===today && t.dueTime){ const dm=hhmmToMin(t.dueTime); if(dm!=null) fire('due:'+t.id+':'+today+':'+dm, dm-lead, '📌 마감 임박: '+t.title, `${t.dueTime} 마감`); }
    });
    (state.events||[]).forEach(ev=>{
      if(!ev.allDay && ev.start!=null && eventOccursOn(ev,today))
        fire('ev:'+ev.id+':'+today+':'+ev.start, ev.start-lead, '📅 일정: '+ev.title, `${minToHHMM(ev.start)} 시작`);
    });
  }
  function startReminderLoop(){
    if(notifyTimer){ clearInterval(notifyTimer); notifyTimer=null; }
    if(!notifyEnabled()) return;
    checkReminders();
    notifyTimer=setInterval(checkReminders, 30000);
  }

  // ---------- PWA 설치 ----------
  // isStandalone·installInstructions → logic.js

  // ---------- 스마트 추천 (지금 이 틈) ----------
  // 설계 원칙: AI는 추천만, 결정은 사람. 자동 배치/삭제 금지.
  // 추천 점수(suggestScore 등)는 logic.js
  let suggestMin = 15;
  const GAP_OPTS = [5,10,15,30,60];
  function renderSuggest(){
    $('#viewTitle').textContent='지금 이 틈';
    $('#viewSub').textContent='지금 가진 시간으로 할 수 있는 가장 좋은 일';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='suggest'));
    content.innerHTML='';
    const wrap=el(`<div class="suggest">
      <div class="gap-pick">
        <div class="q">⏳ 지금 몇 분의 틈이 있나요?</div>
        <div class="gap-chips" id="gapChips"></div>
      </div>
      <div class="suggest-lead">가용 시간·우선순위·소요·마감을 고려한 추천입니다. 결정은 직접 하세요.</div>
      <div id="sgList" style="display:flex;flex-direction:column;gap:10px"></div>
    </div>`);
    content.appendChild(wrap);
    const chips=wrap.querySelector('#gapChips');
    GAP_OPTS.forEach(m=>{ const b=el(`<button class="${m===suggestMin?'sel':''}">${m}분</button>`); b.onclick=()=>{suggestMin=m;renderSuggest();}; chips.appendChild(b); });
    const custom=el(`<input type="number" min="5" step="5" placeholder="직접" value="${GAP_OPTS.includes(suggestMin)?'':suggestMin}">`);
    custom.onchange=()=>{ const v=+custom.value; if(v>0){ suggestMin=v; renderSuggest(); } };
    chips.appendChild(custom);

    const cands=state.tasks.filter(t=>!isDone(t)&&t.status!=='someday'&&(!t.estimate||t.estimate<=suggestMin))
      .map(t=>({t,...suggestScore(t,suggestMin)}))
      .sort((a,b)=> b.score-a.score || (a.t.createdAt-b.t.createdAt))
      .slice(0,6);
    const list=wrap.querySelector('#sgList');
    if(!cands.length){
      list.appendChild(el(`<div class="empty"><div class="big">🍃</div>이 틈에 딱 맞는 일이 없어요.<br>큰 일을 더 잘게 나누거나, 소요 시간을 입력해 보세요.</div>`));
      return;
    }
    cands.forEach(({t,reason},i)=>{
      const card=el(`<div class="sg-card ${i===0?'top':''}">
        <span class="sg-rank">${i===0?'★':i+1}</span>
        <div class="sg-body"><div class="sg-title">${esc(t.title)}</div><div class="sg-meta"></div></div>
        <div class="sg-actions">
          <button class="btn sm primary" data-a="focus">🍅 집중</button>
          <button class="btn sm" data-a="today">오늘</button>
          <button class="btn sm" data-a="done">✓</button>
        </div>
      </div>`);
      const meta=card.querySelector('.sg-meta');
      meta.appendChild(el(`<span class="chip why">💡 ${reason}</span>`));
      if(t.estimate) meta.appendChild(el(`<span class="chip">⏱ ${t.estimate}분</span>`));
      else meta.appendChild(el(`<span class="chip" style="color:var(--muted)">⏱ 소요 미정</span>`));
      if(t.priority<=3) meta.appendChild(el(`<span class="chip" style="color:var(--p${t.priority})">P${t.priority}</span>`));
      if(t.due){ const ov=isOverdue(t.due); meta.appendChild(el(`<span class="chip due ${ov?'overdue':''}">📅 ${fmtDue(t.due)}</span>`)); }
      if(t.projectId){ const p=state.projects.find(x=>x.id===t.projectId); if(p) meta.appendChild(el(`<span class="chip">${esc(p.name)}</span>`)); }
      card.querySelector('[data-a="focus"]').onclick=()=>startPomoForTask(t.id);
      card.querySelector('[data-a="today"]').onclick=()=>{ t.due=todayStr(); if(t.status==='inbox'||t.status==='waiting')t.status='next'; t.updatedAt=Date.now(); save(); renderSuggest(); };
      card.querySelector('[data-a="done"]').onclick=()=>{ toggleDone(t.id); renderSuggest(); };
      card.querySelector('.sg-title').onclick=()=>openTask(t.id);
      list.appendChild(card);
    });
  }

  // ---------- 일일 리뷰 ----------
  let reviewDate = todayStr();
  function dateOfTs(ts){ return todayStr(new Date(ts)); }
  function renderReview(){
    $('#viewTitle').textContent='일일 리뷰';
    $('#viewSub').textContent='오늘을 돌아보고 내일을 준비하세요';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='review'));
    content.innerHTML='';
    const d=new Date(reviewDate+'T00:00:00');
    const completed=state.tasks.filter(t=>isDone(t)&&t.completedAt&&dateOfTs(t.completedAt)===reviewDate);
    const daySessions=(state.sessions||[]).filter(s=>s.date===reviewDate);
    const focusMin=daySessions.reduce((a,b)=>a+(b.duration||0),0);
    const leftover=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.due&&t.due<=reviewDate));
    const headline = completed.length
      ? `오늘 ${completed.length}개를 해냈어요 👏`
      : '아직 완료한 일이 없어요. 작은 한 걸음부터.';
    const wrap=el(`<div class="review">
      <div class="rv-head">
        <button class="btn sm" id="rvPrev">‹</button>
        <strong style="flex:1;text-align:center">${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} (${'일월화수목금토'[d.getDay()]})</strong>
        <button class="btn sm" id="rvNext">›</button>
        <button class="btn sm" id="rvToday">오늘</button>
      </div>
      <div class="rv-headline"><div class="big">${headline}</div><div class="sub">작은 틈이 모여 의미 있는 진전이 됩니다.</div></div>
      <div class="rv-stats">
        <div class="rv-stat"><div class="n green">${completed.length}</div><div class="l">완료한 일</div></div>
        <div class="rv-stat"><div class="n blue">${focusMin}</div><div class="l">집중 시간(분)</div></div>
        <div class="rv-stat"><div class="n">${daySessions.length}</div><div class="l">뽀모도로</div></div>
      </div>
      <div class="rv-sec" id="rvDone"></div>
      <div class="rv-sec" id="rvLeft"></div>
    </div>`);
    content.appendChild(wrap);
    wrap.querySelector('#rvPrev').onclick=()=>{const x=new Date(reviewDate);x.setDate(x.getDate()-1);reviewDate=todayStr(x);renderReview();};
    wrap.querySelector('#rvNext').onclick=()=>{const x=new Date(reviewDate);x.setDate(x.getDate()+1);reviewDate=todayStr(x);renderReview();};
    wrap.querySelector('#rvToday').onclick=()=>{reviewDate=todayStr();renderReview();};

    const doneSec=wrap.querySelector('#rvDone');
    doneSec.appendChild(el(`<h3>✅ 완료한 일</h3>`));
    if(!completed.length) doneSec.appendChild(el(`<div class="note">이 날 완료한 일이 없습니다.</div>`));
    completed.forEach(t=>doneSec.appendChild(el(`<div class="rv-item"><span class="done-dot">✓</span> ${esc(t.title)}</div>`)));

    const leftSec=wrap.querySelector('#rvLeft');
    const leftHead=el(`<h3 style="display:flex;justify-content:space-between;align-items:center">🌙 남은 일 <span></span></h3>`);
    leftSec.appendChild(leftHead);
    if(!leftover.length){ leftSec.appendChild(el(`<div class="note">남은 일이 없습니다. 깔끔하네요!</div>`)); }
    else {
      const btn=el(`<button class="btn sm">전부 내일로 이월</button>`);
      btn.onclick=()=>{ const x=new Date(reviewDate);x.setDate(x.getDate()+1); const nd=todayStr(x); leftover.forEach(t=>{t.due=nd;t.updatedAt=Date.now();}); save(); renderReview(); };
      leftHead.querySelector('span').appendChild(btn);
      leftover.forEach(t=>{
        const row=el(`<div class="rv-item"><span style="flex:1">${esc(t.title)} ${isOverdue(t.due)?'<span class="pt-badge">밀림</span>':''}</span><button class="btn sm" data-a="tomorrow">내일로</button></div>`);
        row.querySelector('[data-a="tomorrow"]').onclick=()=>{ const x=new Date(reviewDate);x.setDate(x.getDate()+1); t.due=todayStr(x); t.updatedAt=Date.now(); save(); renderReview(); };
        leftSec.appendChild(row);
      });
    }
  }

  // ---------- 주간 리뷰 (GTD weekly review) ----------
  let weekReviewStart = startOfWeekDS(todayStr());
  function renderWeekReview(){
    $('#viewTitle').textContent='주간 리뷰';
    $('#viewSub').textContent='한 주를 돌아보고 다음 주를 준비하세요';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='weekreview'));
    content.innerHTML='';
    const ws=weekReviewStart, we=addDaysDS(ws,6);
    const days=[]; for(let i=0;i<7;i++) days.push(addDaysDS(ws,i));
    const inWeek=ds=>ds>=ws&&ds<=we;
    const completed=state.tasks.filter(t=>isDone(t)&&t.completedAt&&inWeek(dateOfTs(t.completedAt)));
    const weekSessions=(state.sessions||[]).filter(s=>inWeek(s.date));
    const focusMin=weekSessions.reduce((a,b)=>a+(b.duration||0),0);
    const activeDays=new Set(completed.map(t=>dateOfTs(t.completedAt)).concat(weekSessions.map(s=>s.date))).size;
    const leftover=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.due&&t.due<=we));
    // 요일별 완료 수
    const perDay=days.map(ds=>completed.filter(t=>dateOfTs(t.completedAt)===ds).length);
    const maxDay=Math.max(1,...perDay);
    // 프로젝트별 완료
    const byProj={}; completed.forEach(t=>{ const k=t.projectId||''; byProj[k]=(byProj[k]||0)+1; });
    const projRows=Object.entries(byProj).sort((a,b)=>b[1]-a[1]);
    const sd=parseDS(ws), ed=parseDS(we);
    const rangeLabel=`${sd.getMonth()+1}.${sd.getDate()} – ${ed.getMonth()+1}.${ed.getDate()}`;
    const headline=completed.length?`이번 주 ${completed.length}개를 해냈어요 👏`:'이번 주 기록이 아직 없어요. 작은 한 걸음부터.';
    if(!state.weekNotes) state.weekNotes={};
    const note=state.weekNotes[ws]||'';
    const wrap=el(`<div class="review">
      <div class="rv-head">
        <button class="btn sm" id="wrPrev">‹</button>
        <strong style="flex:1;text-align:center">${rangeLabel} 주간</strong>
        <button class="btn sm" id="wrNext">›</button>
        <button class="btn sm" id="wrThis">이번 주</button>
      </div>
      <div class="rv-headline"><div class="big">${headline}</div><div class="sub">작은 틈이 모여 의미 있는 진전이 됩니다.</div></div>
      <div class="rv-stats">
        <div class="rv-stat"><div class="n green">${completed.length}</div><div class="l">완료한 일</div></div>
        <div class="rv-stat"><div class="n blue">${focusMin}</div><div class="l">집중 시간(분)</div></div>
        <div class="rv-stat"><div class="n">${weekSessions.length}</div><div class="l">뽀모도로</div></div>
        <div class="rv-stat"><div class="n">${activeDays}</div><div class="l">활동한 날</div></div>
      </div>
      <div class="rv-sec"><h3>📊 요일별 완료</h3><div class="wr-bars"></div></div>
      <div class="rv-sec" id="wrProj"></div>
      <div class="rv-sec" id="wrLeft"></div>
      <div class="rv-sec"><h3>📝 이번 주 회고</h3><textarea id="wrNote" rows="3" placeholder="무엇이 잘 됐고, 다음 주엔 무엇을 바꿔볼까요?">${esc(note)}</textarea></div>
    </div>`);
    content.appendChild(wrap);
    wrap.querySelector('#wrPrev').onclick=()=>{ weekReviewStart=addDaysDS(weekReviewStart,-7); renderWeekReview(); };
    wrap.querySelector('#wrNext').onclick=()=>{ weekReviewStart=addDaysDS(weekReviewStart,7); renderWeekReview(); };
    wrap.querySelector('#wrThis').onclick=()=>{ weekReviewStart=startOfWeekDS(todayStr()); renderWeekReview(); };
    // 요일별 막대
    const bars=wrap.querySelector('.wr-bars');
    days.forEach((ds,i)=>{ const dd=parseDS(ds); const h=Math.round(perDay[i]/maxDay*100);
      const col=el(`<div class="wr-bar ${ds===todayStr()?'today':''}"><div class="wr-bar-fill" style="height:${perDay[i]?Math.max(8,h):0}%"></div><div class="wr-bar-n">${perDay[i]||''}</div><div class="wr-bar-d">${DOW[dd.getDay()]}</div></div>`);
      bars.appendChild(col);
    });
    // 프로젝트별
    const projSec=wrap.querySelector('#wrProj');
    projSec.appendChild(el(`<h3>📁 프로젝트별 진행</h3>`));
    if(!projRows.length) projSec.appendChild(el(`<div class="note">완료한 일이 없습니다.</div>`));
    projRows.forEach(([pid,cnt])=>{
      const p=pid?state.projects.find(x=>x.id===pid):null;
      const name=p?p.name:'프로젝트 없음'; const color=p?p.color:'var(--muted)';
      projSec.appendChild(el(`<div class="rv-item"><span class="proj-color" style="background:${color}"></span><span style="flex:1">${esc(name)}</span><b>${cnt}</b></div>`));
    });
    // 이월
    const leftSec=wrap.querySelector('#wrLeft');
    const leftHead=el(`<h3 style="display:flex;justify-content:space-between;align-items:center">🌙 남은 일 <span></span></h3>`);
    leftSec.appendChild(leftHead);
    if(!leftover.length){ leftSec.appendChild(el(`<div class="note">남은 일이 없습니다. 깔끔하네요!</div>`)); }
    else {
      const nextMon=addDaysDS(ws,7);
      const btn=el(`<button class="btn sm">전부 다음 주로 이월</button>`);
      btn.onclick=()=>{ leftover.forEach(t=>{t.due=nextMon;t.updatedAt=Date.now();}); save(); renderWeekReview(); };
      leftHead.querySelector('span').appendChild(btn);
      leftover.forEach(t=>{
        const row=el(`<div class="rv-item"><span style="flex:1">${esc(t.title)} ${isOverdue(t.due)?'<span class="pt-badge">밀림</span>':''}</span><button class="btn sm" data-a="next">다음 주로</button></div>`);
        row.querySelector('[data-a="next"]').onclick=()=>{ t.due=nextMon; t.updatedAt=Date.now(); save(); renderWeekReview(); };
        leftSec.appendChild(row);
      });
    }
    // 회고 메모 저장
    const ta=wrap.querySelector('#wrNote');
    ta.addEventListener('change',()=>{ const v=ta.value.trim(); if(v) state.weekNotes[ws]=v; else delete state.weekNotes[ws]; save(); });
  }

  // ---------- Settings / Cloud sync ----------
  function renderSettings(){
    $('#viewTitle').textContent='설정';
    $('#viewSub').textContent='클라우드 동기화 · 데이터';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='settings'));
    content.innerHTML='';
    const authBox = authUser
      ? `<div class="row" style="align-items:center"><div class="note" style="flex:1">✅ Google 로그인됨: <b>${esc(authUser.email||'계정')}</b><br>이 계정으로 모든 기기가 자동 동기화됩니다.</div><button class="btn" id="cf-logout">로그아웃</button></div>`
      : `<button class="btn primary" id="cf-google">🔑 Google 계정으로 로그인</button><div class="note">로그인하면 어느 기기에서든 같은 데이터가 자동으로 동기화됩니다.</div>`;
    const box=el(`<div style="max-width:640px;display:flex;flex-direction:column;gap:18px">
      <div class="task" style="flex-direction:column;align-items:stretch;gap:14px">
        <strong>👤 계정</strong>
        ${authBox}
      </div>

      <div class="task" style="flex-direction:column;align-items:stretch;gap:12px">
        <strong>📲 앱으로 설치</strong>
        <div class="note">홈 화면·독에 설치하면 앱처럼 바로 열리고, 띄워두기 쉬워 알림을 놓치지 않습니다.</div>
        <div id="install-area"></div>
      </div>

      <div class="task" style="flex-direction:column;align-items:stretch;gap:12px">
        <strong>🔔 알림</strong>
        <div class="note">앱이 켜져 있을 때 타임블록 시작·마감 시간·일정 시작·뽀모도로 종료를 알려줍니다. (앱을 완전히 닫으면 동작하지 않습니다)</div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="nt-on" style="width:auto" ${state.settings.notify?'checked':''}> 알림 사용</label>
        <div class="row" style="align-items:flex-end">
          <div class="field"><label>미리 알림 (분 전)</label>
            <select id="nt-lead">${[0,1,3,5,10,15,30].map(m=>`<option value="${m}" ${(state.settings.notifyLead!=null?state.settings.notifyLead:5)===m?'selected':''}>${m===0?'정시':m+'분 전'}</option>`).join('')}</select>
          </div>
          <button class="btn" id="nt-test">테스트 알림</button>
        </div>
        <div class="note" id="nt-status"></div>
      </div>

      <div class="task" style="flex-direction:column;align-items:stretch;gap:10px">
        <strong>📅 공휴일 / 휴무일</strong>
        <div class="note">여기에 등록한 날짜는 '공휴일 제외'를 켠 정기 일정에서 자동으로 빠집니다.</div>
        <div class="row" style="align-items:flex-end">
          <div class="field"><label>날짜 추가</label><input id="hol-date" type="date"></div>
          <button class="btn" id="hol-add">추가</button>
          <button class="btn" id="hol-kr">올해 한국 공휴일(고정일) 추가</button>
        </div>
        <div id="hol-list" style="display:flex;flex-wrap:wrap;gap:6px"></div>
      </div>

      <div class="task" style="flex-direction:column;align-items:stretch;gap:10px">
        <strong>💾 데이터 백업 / 복원</strong>
        <div class="row">
          <button class="btn" id="exp">JSON 내보내기</button>
          <button class="btn" id="imp">JSON 가져오기</button>
          <button class="btn" id="rst" style="color:var(--p1)">초기화</button>
        </div>
        <input type="file" id="impFile" accept="application/json" style="display:none">
      </div>
    </div>`);
    content.appendChild(box);

    if(box.querySelector('#cf-google')) box.querySelector('#cf-google').onclick=googleLogin;
    if(box.querySelector('#cf-logout')) box.querySelector('#cf-logout').onclick=googleLogout;
    // 앱 설치
    const installArea=box.querySelector('#install-area');
    const renderInstall=()=>{
      installArea.innerHTML='';
      if(isStandalone()){ installArea.appendChild(el(`<div class="note">✅ 이미 앱으로 실행 중입니다.</div>`)); return; }
      if(deferredInstall){
        const b=el(`<button class="btn primary">📲 앱 설치</button>`);
        b.onclick=async()=>{
          try{ deferredInstall.prompt(); const {outcome}=await deferredInstall.userChoice;
            if(outcome==='accepted'){ deferredInstall=null; toast('설치를 시작했습니다.'); } }
          catch(_){}
          renderInstall();
        };
        installArea.appendChild(b);
      } else {
        const b=el(`<button class="btn">설치 방법 보기</button>`);
        const guide=el(`<div class="note" style="display:none;margin-top:8px">${esc(installInstructions())}</div>`);
        b.onclick=()=>{ guide.style.display=guide.style.display==='none'?'':'none'; };
        installArea.appendChild(b); installArea.appendChild(guide);
      }
    };
    renderInstall();
    box.querySelector('#exp').onclick=exportJson;
    box.querySelector('#imp').onclick=()=>$('#impFile').click();
    box.querySelector('#impFile').onchange=importJson;
    box.querySelector('#rst').onclick=()=>{ if(confirm('모든 로컬 데이터를 초기화할까요?')){ state=defaultState(); save(); render(); } };
    // 알림 설정
    const ntStatus=box.querySelector('#nt-status');
    const refreshNtStatus=()=>{
      if(!notifySupported()){ ntStatus.textContent='⚠️ 이 브라우저는 알림을 지원하지 않습니다.'; return; }
      if(!state.settings.notify){ ntStatus.textContent='알림이 꺼져 있습니다.'; return; }
      ntStatus.innerHTML = Notification.permission==='granted'
        ? '상태: <b style="color:var(--green)">켜짐</b> · 앱이 켜져 있을 때만 동작합니다.'
        : '⚠️ 브라우저 알림 권한이 필요합니다. 사이트 권한에서 허용해 주세요.';
    };
    box.querySelector('#nt-on').onchange=async e=>{
      if(e.target.checked){
        const ok=await enableNotifications();
        if(!ok){ e.target.checked=false; state.settings.notify=false; save(); refreshNtStatus(); return; }
        state.settings.notify=true;
      } else { state.settings.notify=false; }
      save(); startReminderLoop(); refreshNtStatus();
    };
    box.querySelector('#nt-lead').onchange=e=>{ state.settings.notifyLead=+e.target.value||0; save(); };
    box.querySelector('#nt-test').onclick=async()=>{
      const ok=await enableNotifications(); if(!ok){ refreshNtStatus(); return; }
      showNotify('🔔 틈(TEUM) 알림','알림이 정상 동작합니다.','teum-test');
      toast('테스트 알림을 보냈어요. 안 보이면 OS 알림/방해금지(집중) 설정을 확인하세요.');
    };
    refreshNtStatus();
    // 공휴일 관리
    const renderHol=()=>{
      const list=box.querySelector('#hol-list'); list.innerHTML='';
      const hs=(state.holidays||[]).slice().sort();
      if(!hs.length){ list.appendChild(el(`<div class="note">등록된 날짜가 없습니다.</div>`)); return; }
      hs.forEach(d=>{ const chip=el(`<span class="chip">${d} <button class="iconbtn" style="padding:0 2px">✕</button></span>`);
        chip.querySelector('button').onclick=()=>{ state.holidays=state.holidays.filter(x=>x!==d); save(); renderHol(); };
        list.appendChild(chip); });
    };
    box.querySelector('#hol-add').onclick=()=>{ const v=box.querySelector('#hol-date').value; if(v&&!(state.holidays||[]).includes(v)){ if(!state.holidays)state.holidays=[]; state.holidays.push(v); save(); renderHol(); } };
    box.querySelector('#hol-kr').onclick=()=>{
      const y=new Date().getFullYear();
      const fixed=[`${y}-01-01`,`${y}-03-01`,`${y}-05-05`,`${y}-06-06`,`${y}-08-15`,`${y}-10-03`,`${y}-10-09`,`${y}-12-25`];
      if(!state.holidays)state.holidays=[];
      fixed.forEach(d=>{ if(!state.holidays.includes(d)) state.holidays.push(d); });
      save(); renderHol();
    };
    renderHol();
  }

  function exportJson(){
    const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=`flowdo-${todayStr()}.json`; a.click();
  }
  function importJson(e){
    const f=e.target.files[0]; if(!f) return;
    const r=new FileReader(); r.onload=()=>{ try{ const s=JSON.parse(r.result); if(s.tasks){ state=migrate(s); save(); render(); alert('가져오기 완료'); } }catch(err){ alert('잘못된 파일'); } }; r.readAsText(f);
  }

  // Supabase via dynamic import (CDN). Loads only when configured.
  async function initSupa(){
    if(!(cloud.url&&cloud.key)){ supa=null; authUser=null; updateSyncBadge(); return; }
    try{
      const mod=await import('https://esm.sh/@supabase/supabase-js@2');
      supa=mod.createClient(cloud.url,cloud.key);
      // 기존 세션 확인 + 상태 변화 구독 (Google 로그인)
      supa.auth.getSession().then(({data})=>{
        authUser=data&&data.session?data.session.user:null;
        authChecked=true; updateAuthGate();
        updateSyncBadge(); if(currentView==='settings') renderSettings();
        if(syncKey()) cloudPull(false);
      });
      supa.auth.onAuthStateChange((_e,session)=>{
        authUser=session?session.user:null;
        authChecked=true; updateAuthGate();
        updateSyncBadge(); if(currentView==='settings') renderSettings();
        if(authUser&&syncKey()) cloudPull(false);
      });
      updateSyncBadge();
      if(syncKey()) await cloudPull(false);
    }catch(err){ console.warn('Supabase init 실패',err); supa=null; authChecked=true; updateAuthGate(); updateSyncBadge(); }
  }
  // 로그인 게이트: 로그인 전까지 앱 위를 덮는다(로그인 필수).
  function updateAuthGate(){
    const g=document.getElementById('authGate'); if(!g) return;
    g.classList.toggle('checking', !authChecked);
    g.classList.toggle('show', !authUser);
  }
  async function googleLogin(){
    if(!supa){ await initSupa(); }
    if(!supa){ alert('로그인 서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.'); return; }
    const {error}=await supa.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+location.pathname}});
    if(error) alert('로그인 실패: '+error.message);
  }
  async function googleLogout(){
    if(supa) await supa.auth.signOut();
    authUser=null; updateSyncBadge(); updateAuthGate(); if(currentView==='settings') renderSettings();
  }
  function updateSyncBadge(){
    const b=$('#syncBadge'); if(!b) return;
    if(supa&&authUser){ b.textContent='Google'; b.classList.add('on'); }
    else if(supa&&syncKey()){ b.textContent='동기화'; b.classList.add('on'); }
    else { b.textContent='로컬'; b.classList.remove('on'); }
  }
  function scheduleSync(){
    if(!supa||!syncKey()) return;
    clearTimeout(syncTimer);
    syncTimer=setTimeout(()=>cloudPush(false),1200);
  }
  // 내용 시그니처(휘발성 updatedAt 제외) — 실제 변경이 없으면 업로드를 건너뛰기 위함
  function syncSig(){ const c=Object.assign({},state); delete c.updatedAt; return JSON.stringify(c); }
  async function cloudPush(manual){
    if(!supa||!syncKey()){ if(manual) alert('먼저 연결(또는 로그인)을 설정하세요.'); return; }
    const sig=syncSig();
    if(!manual && sig===lastSyncSig) return; // 내용 변화 없으면 네트워크 생략
    try{
      const payload={id:syncKey(),data:state,updated_at:state.updatedAt};
      const {error}=await supa.from('flowdo').upsert(payload);
      if(error) throw error;
      lastSyncSig=sig;
      if(manual) toast('서버로 올렸습니다.');
    }catch(err){ console.warn(err); if(manual) alert('업로드 실패: '+(err.message||err)); }
  }
  async function cloudPull(manual){
    if(!supa||!syncKey()){ if(manual) alert('먼저 연결(또는 로그인)을 설정하세요.'); return; }
    try{
      const {data,error}=await supa.from('flowdo').select('data,updated_at').eq('id',syncKey()).maybeSingle();
      if(error) throw error;
      if(data&&data.data){
        if(manual || data.updated_at>(state.updatedAt||0)){
          state=migrate(data.data); localStorage.setItem(LS_KEY,JSON.stringify(state));
          lastSyncSig=syncSig(); // 방금 받은 내용은 다시 올리지 않도록 시그니처 갱신
          render();
          if(manual) toast('서버에서 불러왔습니다.');
        }
      } else if(manual){ toast('서버에 데이터가 없어 현재 내용을 올립니다.'); cloudPush(true); }
    }catch(err){ console.warn(err); if(manual) alert('불러오기 실패: '+(err.message||err)); }
  }
  function toast(msg){
    const t=el(`<div style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 18px;border-radius:24px;font-size:14px;z-index:99;box-shadow:var(--shadow)">${esc(msg)}</div>`);
    document.body.appendChild(t); setTimeout(()=>t.remove(),2200);
  }

  // ---------- Helpers (el·esc·$ 등 순수 헬퍼는 helpers.js) ----------
  // 사이드바 항목에 할 일 카드 드롭 → 상태/프로젝트/태그/오늘 변경
  function makeNavDrop(elem, fn){
    elem.addEventListener('dragover',e=>{e.preventDefault();elem.classList.add('nav-drop');});
    elem.addEventListener('dragleave',e=>{ if(e.target===elem) elem.classList.remove('nav-drop'); });
    elem.addEventListener('drop',e=>{
      e.preventDefault(); elem.classList.remove('nav-drop');
      const id=e.dataTransfer.getData('text/plain'); const t=state.tasks.find(x=>x.id===id);
      if(t){ fn(t); t.updatedAt=Date.now(); save(); render(); }
    });
  }

  // ---------- Sidebar mobile ----------
  function openSidebar(){ $('#sidebar').classList.add('open'); $('#backdrop').classList.add('show'); }
  function closeSidebar(){ $('#sidebar').classList.remove('open'); $('#backdrop').classList.remove('show'); }

  // ---------- Events ----------
  const navDropActions={
    today:t=>{ t.due=todayStr(); t.completedAt=null; if(t.status==='done') t.status=t._prev||'next'; },
    inbox:t=>{ t.status='inbox'; t.completedAt=null; },
    next:t=>{ t.status='next'; t.completedAt=null; },
    waiting:t=>{ t.status='waiting'; t.completedAt=null; },
    someday:t=>{ t.status='someday'; t.completedAt=null; },
    done:t=>{ if(t.status!=='done'){ t._prev=t.status; t.status='done'; t.completedAt=Date.now(); } },
  };
  document.querySelectorAll('.nav[data-view]').forEach(b=>{
    b.addEventListener('click',()=>setView(b.dataset.view));
    const act=navDropActions[b.dataset.view]; if(act) makeNavDrop(b,act);
  });
  $('#addProjectBtn').onclick=openProject;
  $('#newTaskBtn').onclick=()=>openTask(null);
  $('#menuBtn').onclick=openSidebar;
  $('#pomoMini').onclick=()=>setView('pomodoro');
  $('#backdrop').onclick=closeSidebar;
  $('#taskSaveBtn').onclick=saveTask;
  $('#taskCancelBtn').onclick=closeTask;
  $('#taskDeleteBtn').onclick=()=>{ if(editingId){ delTask(editingId); closeTask(); } };
  $('#projSaveBtn').onclick=saveProject;
  $('#projCancelBtn').onclick=()=>$('#projOverlay').classList.remove('show');
  $('#evSaveBtn').onclick=saveEvent;
  $('#evCancelBtn').onclick=()=>$('#eventOverlay').classList.remove('show');
  $('#evDeleteBtn').onclick=()=>{ if(editingEventId){ state.events=(state.events||[]).filter(x=>x.id!==editingEventId); save(); $('#eventOverlay').classList.remove('show'); renderPlan(); } };
  $('#ev-freq').onchange=updateEventModalVisibility;
  $('#ev-allday').onchange=updateEventModalVisibility;
  $('#f-add-sub').onclick=addSubtask;
  $('#ev-endmode').onchange=updateEventModalVisibility;
  $('#ev-monthmode').onchange=updateEventModalVisibility;
  document.querySelectorAll('#evDays button').forEach(b=>b.onclick=()=>b.classList.toggle('sel'));
  document.querySelectorAll('#prioPick button').forEach(b=>b.onclick=()=>setPrio(+b.dataset.p));
  document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('show');}));
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ closeTask(); $('#projOverlay').classList.remove('show'); $('#eventOverlay').classList.remove('show'); }
    if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&$('#taskOverlay').classList.contains('show')) saveTask();
    if(e.key==='n'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)&&!$('#taskOverlay').classList.contains('show')){ e.preventDefault(); openTask(null); }
  });

  // ---------- Service worker ----------
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('service-worker.js').catch(()=>{}); }

  // ---------- Boot ----------
  const gateBtn=document.getElementById('gate-google');
  if(gateBtn) gateBtn.onclick=googleLogin;
  // PWA 설치 프롬프트 캡처 (Chromium 계열)
  window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredInstall=e; if(currentView==='settings') renderSettings(); });
  window.addEventListener('appinstalled', ()=>{ deferredInstall=null; toast('앱이 설치되었습니다.'); if(currentView==='settings') renderSettings(); });

  // 첫 실행은 '오늘', 이후엔 마지막으로 본 화면으로 (계획형/실행형 모두 존중)
  const lastView = localStorage.getItem('flowdo.lastview');
  setView(RESTORABLE_VIEWS.has(lastView) ? lastView : 'today');
  updateAuthGate();
  startReminderLoop();
  if(cloud.url&&cloud.key) initSupa();
  // 세션 확인이 지연되면(느린 네트워크 등) 로그인 버튼이라도 보여줌
  setTimeout(()=>{ if(!authChecked){ authChecked=true; updateAuthGate(); } }, 7000);

})();
