/* 틈(TEUM) 순수 헬퍼 (날짜·DOM) — 앱 상태에 의존하지 않음. app.js보다 먼저 로드. */

// ---------- DOM ----------
const $ = s => document.querySelector(s);
function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- Date ----------
function pad(n){ return String(n).padStart(2,'0'); }
function todayStr(d=new Date()){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function parseDS(ds){ return new Date(ds+'T00:00:00'); }
function addDaysDS(ds,n){ const d=parseDS(ds); d.setDate(d.getDate()+n); return todayStr(d); }
function addMonthsDS(ds,n){ const d=parseDS(ds); d.setMonth(d.getMonth()+n); return todayStr(d); }
function startOfWeekDS(ds){ const d=parseDS(ds); d.setDate(d.getDate()-d.getDay()); return todayStr(d); } // 일요일 시작
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
function isDone(t){ return t.status==='done'; }
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
