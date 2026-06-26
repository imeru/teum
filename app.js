/* FlowDo — GTD · 타임블락킹 할 일 관리 (단일 PWA, vanilla JS) */
(() => {
  'use strict';

  // ---------- State ----------
  const LS_KEY = 'flowdo.state.v1';
  const CFG_KEY = 'flowdo.cloud.v1';
  // 공용 백엔드: anon(publishable) 키는 클라이언트 공개용이며 데이터 보호는 RLS가 담당.
  // 모든 방문자가 별도 설정 없이 같은 백엔드로 Google 로그인 → 자동 동기화.
  const DEFAULT_CLOUD = {
    url: 'https://btmyvomigijtikajaazv.supabase.co',
    key: 'sb_publishable_PCfTgna_8CzZBS3F_Gi9AA_y5P-hFUn'
  };
  const PROJECT_COLORS = ['#4f46e5','#16a34a','#e5484d','#f76808','#0091ff','#9333ea','#0d9488','#db2777'];

  let state = load();
  let cloud = loadCfg();
  let currentView = 'today';
  let currentFilter = null; // {type:'project'|'tag', value}
  let editingId = null;
  let selectedPrio = 4;
  let projColor = PROJECT_COLORS[0];
  let supa = null;          // supabase client
  let syncTimer = null;
  let lastPushedHash = '';
  let authUser = null;      // 로그인된 Google 계정
  let authChecked = false;  // 세션 확인 완료 여부 (게이트 로딩 표시용)
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
      settings: { focus:25, short:5, long:15, longEvery:4 },
      top3: {},
      events: [],
      holidays: [],
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
    if(!s.settings) s.settings={ focus:25, short:5, long:15, longEvery:4 };
    if(!s.top3) s.top3={};
    if(!s.events) s.events=[];
    if(!s.holidays) s.holidays=[];
    s.events.forEach(ev=>{
      if(!ev.freq){ ev.freq='weekly'; ev.interval=ev.interval||1; ev.startDate=ev.startDate||todayStr(); ev.endMode=ev.endMode||'never'; ev.endDate=ev.endDate||null; ev.count=ev.count||null; }
      if(ev.freq==='monthly'&&!ev.monthMode) ev.monthMode='date';
      if(ev.excludeHolidays===undefined) ev.excludeHolidays=false;
    });
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

  // ---------- Date helpers ----------
  function todayStr(d=new Date()){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function pad(n){ return String(n).padStart(2,'0'); }
  function fmtDue(s){
    if(!s) return '';
    const d=new Date(s+'T00:00:00'), t=new Date(todayStr()+'T00:00:00');
    const diff=Math.round((d-t)/86400000);
    if(diff===0) return '오늘'; if(diff===1) return '내일'; if(diff===-1) return '어제';
    if(diff<0) return `${-diff}일 지남`;
    if(diff<7) return `${diff}일 후`;
    return `${d.getMonth()+1}/${d.getDate()}`;
  }
  function isOverdue(s){ if(!s) return false; return s < todayStr(); }
  function minToHHMM(m){ return `${pad(Math.floor(m/60))}:${pad(m%60)}`; }
  function hhmmToMin(s){ if(!s) return null; const[a,b]=s.split(':').map(Number); return a*60+b; }
  function startOfWeek(d){ const x=new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate()-x.getDay()); return x; }
  function sameDay(a,b){ return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate(); }
  // 월 n번째 요일 날짜 (ord: 1~5, -1=마지막)
  function nthWeekday(y,m,wd,ord){
    if(ord===-1){ const last=new Date(y,m+1,0); const diff=(last.getDay()-wd+7)%7; return new Date(y,m,last.getDate()-diff); }
    const first=new Date(y,m,1); const diff=(wd-first.getDay()+7)%7; const day=1+diff+(ord-1)*7;
    if(day>new Date(y,m+1,0).getDate()) return null; return new Date(y,m,day);
  }
  // 월간 반복: 해당 연·월의 발생 날짜(Date) 또는 null
  function monthlyOccDate(ev,y,m){
    if(ev.monthMode==='weekday') return nthWeekday(y,m,ev.weekday,ev.ordinal);
    const dom=new Date(ev.startDate+'T00:00:00').getDate();
    if(dom>new Date(y,m+1,0).getDate()) return null;
    return new Date(y,m,dom);
  }
  // 정기 일정이 특정 날짜(ds)에 발생하는가
  function eventOccursOn(ev,ds){
    if(!ev.startDate) ev.startDate=ds;
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
  const $ = s => document.querySelector(s);
  const content = $('#content');

  // ---------- Views ----------
  const VIEWS = {
    today:{title:'오늘', sub:'오늘 마감·예정된 행동', filter:t=>!isDone(t)&&(t.due===todayStr()||isOverdue(t.due)||(t.block&&t.block.date===todayStr()))},
    inbox:{title:'Inbox', sub:'수집함 — 분류가 필요한 항목', filter:t=>!isDone(t)&&t.status==='inbox'},
    next:{title:'다음 행동', sub:'바로 실행할 수 있는 일', filter:t=>!isDone(t)&&t.status==='next'},
    waiting:{title:'대기 중', sub:'다른 사람·조건을 기다리는 일', filter:t=>!isDone(t)&&t.status==='waiting'},
    someday:{title:'언젠가 / 보류', sub:'지금은 아니지만 잊지 않을 일', filter:t=>!isDone(t)&&t.status==='someday'},
    done:{title:'완료', sub:'최근 완료한 일', filter:t=>isDone(t)},
  };
  function isDone(t){ return t.status==='done'; }

  function countFor(fn){ return state.tasks.filter(fn).length; }

  function setView(v, filter=null){
    currentView=v; currentFilter=filter;
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active', n.dataset.view===v && !filter));
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

  function quickAdd(raw){
    let title=raw, priority=4, tags=[], projectId='', due=null, status= currentView==='inbox'?'inbox':'next';
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
    // contextual defaults from current view
    if(currentView==='waiting') status='waiting';
    if(currentView==='someday') status='someday';
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
    const meta=node.querySelector('.task-meta');
    if(t.projectId){ const p=state.projects.find(x=>x.id===t.projectId); if(p) meta.appendChild(el(`<span class="chip"><span class="proj-color" style="background:${p.color}"></span>${esc(p.name)}</span>`)); }
    if(t.due){ const ov=isOverdue(t.due); meta.appendChild(el(`<span class="chip due ${ov?'overdue':''}">📅 ${fmtDue(t.due)}${t.dueTime?' '+t.dueTime:''}</span>`)); }
    if(t.block){ meta.appendChild(el(`<span class="chip block">🗓️ ${t.block.date===todayStr()?'오늘 ':''}${minToHHMM(t.block.start)}</span>`)); }
    if(t.estimate){ meta.appendChild(el(`<span class="chip">⏱ ${t.estimate}분</span>`)); }
    const sc=sessionsForTask(t.id); if(sc) meta.appendChild(el(`<span class="chip pomo">🍅 ${sc}</span>`));
    (t.tags||[]).forEach(tag=>{ const c=el(`<span class="chip tag">${esc(tag)}</span>`); c.addEventListener('click',e=>{e.stopPropagation();setView('tag',{type:'tag',value:tag});}); meta.appendChild(c); });
    if(t.status!=='next'&&t.status!=='done'&&!currentFilter&&currentView!=='today'){}

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
  let planTimer = null;

  function renderPlan(){
    $('#viewTitle').textContent='타임박스';
    $('#viewSub').textContent='왼쪽 할 일을 오른쪽 시간표로 끌어다 놓아 하루를 설계하세요';
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='plan'));
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
          <div class="tb-h"><span>🔁 정기 일정</span><button class="btn sm" id="addEventBtn">＋ 추가</button></div>
          <div id="eventList"></div>
        </div>
      </div>
      <div class="tb-right">
        <div class="tb-week" id="weekStrip"></div>
        <div class="calendar"><div class="cal-grid" id="calGrid"></div></div>
      </div>
    </div>`);
    content.appendChild(wrap);
    const pq=wrap.querySelector('#poolQuick');
    pq.addEventListener('keydown',e=>{ if(e.key==='Enter'&&pq.value.trim()){ quickAdd(pq.value.trim()); pq.value=''; renderPlan(); } });
    wrap.querySelector('#addEventBtn').onclick=openEvent;
    renderMiniCal();
    renderTop3();
    renderWeekStrip();
    renderPool();
    renderEventList();
    renderCalendar();
    startNowLine();
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

  // -- Week strip --
  function renderWeekStrip(){
    const strip=$('#weekStrip'); strip.innerHTML='';
    const start=new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate()-1);
    for(let i=0;i<14;i++){
      const d=new Date(start); d.setDate(start.getDate()+i); const ds=todayStr(d);
      const cell=el(`<div class="day-cell ${ds===planDate?'sel':''} ${ds===todayStr()?'today':''}">
        <div class="dow">${'일월화수목금토'[d.getDay()]}</div>
        <div class="dom">${d.getDate()}</div>
      </div>`);
      cell.onclick=()=>{ planDate=ds; renderPlan(); };
      cell.addEventListener('dragover',e=>e.preventDefault());
      cell.addEventListener('drop',e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');const t=state.tasks.find(x=>x.id===id);if(t){t.due=ds;if(t.block)t.block.date=ds;t.updatedAt=Date.now();save();}planDate=ds;renderPlan();});
      strip.appendChild(cell);
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
        ${isOverdue(t.due)?'<span class="pt-badge">밀림</span>':''}
      </div>`);
      card.addEventListener('dragstart',e=>{dragOffsetMin=0;e.dataTransfer.setData('text/plain',t.id);});
      card.querySelector('.pt-title').addEventListener('click',()=>openTask(t.id));
      pool.appendChild(card);
    });
  }

  // -- Day calendar (10분 단위 · 자유 드래그 이동 · 길이 조절 · 정기 일정 표시) --
  const CAL_START=6, CAL_END=24, SNAP_MIN=10, PX_PER_MIN=1; // 1분=1px, 10분 단위 스냅
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
    // 정기 일정 (반복 이벤트) — 규칙에 따라 해당 날짜에 표시
    (state.events||[]).filter(ev=>eventOccursOn(ev,planDate)).forEach(ev=>{
      const top=minToTop(ev.start), height=Math.max(SNAP_MIN, ev.duration)*PX_PER_MIN-2;
      const card=el(`<div class="event-card" style="top:${top}px;height:${height}px;border-left-color:${ev.color||'#0d9488'}">
        <div class="bc-main"><span class="time">🔁 ${minToHHMM(ev.start)}~${minToHHMM(ev.start+ev.duration)}</span><span class="bc-title">${esc(ev.title)}</span></div>
      </div>`);
      card.title=ev.title+' (정기 일정 — 클릭하여 편집)';
      card.style.cursor='pointer';
      card.addEventListener('click',()=>openEvent(ev.id));
      grid.appendChild(card);
    });
    // 작업 블록
    state.tasks.filter(t=>t.block&&t.block.date===planDate).forEach(t=>{
      const top=minToTop(t.block.start), height=Math.max(SNAP_MIN, t.block.duration)*PX_PER_MIN-2;
      const pc=t.priority<=2?`p${t.priority}`:'';
      const card=el(`<div class="block-card ${pc}" draggable="true" style="top:${top}px;height:${height}px">
        <div class="bc-main"><span class="time">${minToHHMM(t.block.start)}~${minToHHMM(t.block.start+t.block.duration)}</span><span class="bc-title">${esc(t.title)}</span></div>
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

  function scheduleTask(id,min){
    const t=state.tasks.find(x=>x.id===id); if(!t) return;
    const dur=t.block?t.block.duration:(t.estimate||60);
    t.block={date:planDate,start:min,duration:dur};
    if(!t.due) t.due=planDate;
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
  const ORD_LABEL={1:'첫째',2:'둘째',3:'셋째',4:'넷째',5:'다섯째','-1':'마지막'};
  function describeEvent(ev){
    let s;
    if((ev.freq||'weekly')==='weekly'){
      const dl=ev.days.slice().sort((a,b)=>a-b).map(d=>'일월화수목금토'[d]).join('·');
      s=(ev.interval>1?`${ev.interval}주마다 `:'매주 ')+dl;
    } else if(ev.monthMode==='weekday'){
      s=(ev.interval>1?`${ev.interval}개월마다 `:'매월 ')+`${ORD_LABEL[ev.ordinal]||''} ${'일월화수목금토'[ev.weekday]}요일`;
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
  function renderEventList(){
    const host=$('#eventList'); if(!host) return; host.innerHTML='';
    const evs=(state.events||[]).slice().sort((a,b)=>a.start-b.start);
    if(!evs.length){ host.appendChild(el(`<div class="note" style="padding:4px 2px">등록된 정기 일정이 없습니다. 수업·정기 미팅을 추가하세요.</div>`)); return; }
    evs.forEach(ev=>{
      const row=el(`<div class="event-row">
        <span class="ev-color" style="background:${ev.color||'#0d9488'}"></span>
        <span class="ev-info" style="cursor:pointer"><b>${esc(ev.title)}</b><small>${esc(describeEvent(ev))}</small></span>
        <button class="iconbtn" title="삭제">✕</button></div>`);
      row.querySelector('.ev-info').onclick=()=>openEvent(ev.id);
      row.querySelector('button').onclick=()=>{ state.events=state.events.filter(x=>x.id!==ev.id); save(); renderPlan(); };
      host.appendChild(row);
    });
  }
  function updateEventModalVisibility(){
    const freq=$('#ev-freq').value, endMode=$('#ev-endmode').value, monthMode=$('#ev-monthmode').value;
    $('#ev-days-field').style.display=freq==='weekly'?'':'none';
    $('#ev-monthmode-field').style.display=freq==='monthly'?'':'none';
    $('#ev-monthweek-field').style.display=(freq==='monthly'&&monthMode==='weekday')?'':'none';
    $('#ev-enddate-field').style.display=endMode==='date'?'':'none';
    $('#ev-count-field').style.display=endMode==='count'?'':'none';
  }
  function openEvent(id){
    editingEventId=(typeof id==='string')?id:null;
    const ev=editingEventId?(state.events||[]).find(x=>x.id===editingEventId):null;
    $('#eventModalTitle').textContent=ev?'🔁 정기 일정 편집':'🔁 정기 일정 추가';
    $('#evDeleteBtn').style.display=ev?'':'none';
    $('#ev-title').value=ev?ev.title:'';
    $('#ev-start').value=ev?minToHHMM(ev.start):'09:00';
    $('#ev-dur').value=ev?ev.duration:60;
    $('#ev-freq').value=ev?(ev.freq||'weekly'):'weekly';
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
    const data={title,start,duration:dur,freq,interval,days:freq==='weekly'?days:[],
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
    $('#c-today').textContent=countFor(VIEWS.today.filter)||'';
    $('#c-inbox').textContent=countFor(VIEWS.inbox.filter)||'';
    $('#c-next').textContent=countFor(VIEWS.next.filter)||'';
    $('#c-waiting').textContent=countFor(VIEWS.waiting.filter)||'';
    $('#c-someday').textContent=countFor(VIEWS.someday.filter)||'';
    const pc=$('#c-pomo'); if(pc) pc.textContent=todaySessions().length||'';
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
    if(!tags.length){ nav.appendChild(el(`<div class="note" style="padding:2px 12px">아직 태그 없음</div>`)); return; }
    tags.slice(0,12).forEach(tag=>{
      const b=el(`<button class="nav"><span class="ico">#</span> ${esc(tag)}</button>`);
      b.classList.toggle('active',currentFilter&&currentFilter.type==='tag'&&currentFilter.value===tag);
      b.onclick=()=>setView('tag',{type:'tag',value:tag});
      makeNavDrop(b,t=>{ if(!t.tags)t.tags=[]; if(!t.tags.includes(tag))t.tags.push(tag); });
      nav.appendChild(b);
    });
  }

  // ---------- Task modal ----------
  function openTask(id){
    editingId=id;
    const t=id?state.tasks.find(x=>x.id===id):null;
    $('#taskModalTitle').textContent=id?'할 일 편집':'새 할 일';
    $('#taskDeleteBtn').style.display=id?'':'none';
    $('#f-title').value=t?t.title:'';
    $('#f-notes').value=t?t.notes:'';
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
    const data={title,notes:$('#f-notes').value.trim(),status:$('#f-status').value,
      projectId:$('#f-project').value,due,dueTime:due?($('#f-duetime').value||null):null,tags,priority:selectedPrio,
      estimate:(+$('#f-estimate').value||null),block};
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

  // ---------- 스마트 추천 (지금 이 틈) ----------
  // 설계 원칙: AI는 추천만, 결정은 사람. 자동 배치/삭제 금지.
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

    const cands=sortTasks(state.tasks.filter(t=>!isDone(t)&&t.status!=='someday'&&(!t.estimate||t.estimate<=suggestMin))).slice(0,6);
    const list=wrap.querySelector('#sgList');
    if(!cands.length){
      list.appendChild(el(`<div class="empty"><div class="big">🍃</div>이 틈에 딱 맞는 일이 없어요.<br>큰 일을 더 잘게 나누거나, 소요 시간을 입력해 보세요.</div>`));
      return;
    }
    cands.forEach((t,i)=>{
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
      if(t.estimate) meta.appendChild(el(`<span class="chip">⏱ ${t.estimate}분</span>`));
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
    box.querySelector('#exp').onclick=exportJson;
    box.querySelector('#imp').onclick=()=>$('#impFile').click();
    box.querySelector('#impFile').onchange=importJson;
    box.querySelector('#rst').onclick=()=>{ if(confirm('모든 로컬 데이터를 초기화할까요?')){ state=defaultState(); save(); render(); } };
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
    const r=new FileReader(); r.onload=()=>{ try{ const s=JSON.parse(r.result); if(s.tasks){ state=s; save(); render(); alert('가져오기 완료'); } }catch(err){ alert('잘못된 파일'); } }; r.readAsText(f);
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
  async function cloudPush(manual){
    if(!supa||!syncKey()){ if(manual) alert('먼저 연결(또는 로그인)을 설정하세요.'); return; }
    try{
      const payload={id:syncKey(),data:state,updated_at:state.updatedAt};
      const {error}=await supa.from('flowdo').upsert(payload);
      if(error) throw error;
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
          state=data.data; localStorage.setItem(LS_KEY,JSON.stringify(state)); render();
          if(manual) toast('서버에서 불러왔습니다.');
        }
      } else if(manual){ toast('서버에 데이터가 없어 현재 내용을 올립니다.'); cloudPush(true); }
    }catch(err){ console.warn(err); if(manual) alert('불러오기 실패: '+(err.message||err)); }
  }
  function toast(msg){
    const t=el(`<div style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 18px;border-radius:24px;font-size:14px;z-index:99;box-shadow:var(--shadow)">${esc(msg)}</div>`);
    document.body.appendChild(t); setTimeout(()=>t.remove(),2200);
  }

  // ---------- Helpers ----------
  function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; }
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
  function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
  setView('plan');
  updateAuthGate();
  if(cloud.url&&cloud.key) initSupa();
  // 세션 확인이 지연되면(느린 네트워크 등) 로그인 버튼이라도 보여줌
  setTimeout(()=>{ if(!authChecked){ authChecked=true; updateAuthGate(); } }, 7000);

})();
