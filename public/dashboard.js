const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('cup-scanner-key') || '', timer, pending = false, lastState;
const num = n => Number(n||0).toLocaleString();
const duration = seconds => seconds === null ? '—' : seconds < 60 ? `${Math.ceil(seconds)}s` : `${Math.floor(seconds/60)}m ${Math.ceil(seconds%60)}s`;
const date = iso => iso ? new Date(iso).toLocaleString() : 'Not yet';
function text(id,value) { $(id).textContent=value; }
function render(s) {
  lastState=s; $('login').hidden=true; $('dashboard').hidden=false;
  text('mode',s.mode[0].toUpperCase()+s.mode.slice(1)); text('cycle',`SCAN ${s.cycle||'—'}`);
  $('beacon').className=`beacon ${s.mode}`;
  const titles={catalog:'Discovering clubs.',players:'Collecting player ratings.',publish:'Building the complete snapshot.',sync:'Syncing the latest results.'};
  text('stage',s.mode==='stopped'?'Ready when you are.':titles[s.stage]);
  text('detail',s.mode==='stopped'?'Start a fresh scan to update Cup Seedings and League Strengths.':s.mode==='paused'?'Checkpoint saved. Start resumes from this position.':s.stage==='catalog'?`${s.divisionIndex} of 10 divisions collected.`:s.stage==='players'?`${num(s.players)} players collected across ${num(s.pages)} pages.`:s.stage==='publish'?'Calculating Top 11, Top 16, full squad ratings and retirement counts.':'Publishing the completed scan before the next one begins.');
  if(s.progressPercent===null && s.mode==='running') $('progress').removeAttribute('value'); else $('progress').value=s.progressPercent||0;
  for(const el of document.querySelectorAll('[data-stage]')) el.classList.toggle('current',el.dataset.stage===s.stage&&s.mode!=='stopped');
  $('start').disabled=pending||s.mode==='running'; text('start',s.mode==='paused'?'Resume scan':'Start scan');
  $('pause').disabled=pending||s.mode!=='running'; $('stop').disabled=pending||s.mode==='stopped';
  text('eta',duration(s.etaSeconds)); text('etaBasis',s.mode==='paused'?'Paused at checkpoint':s.etaBasis);
  text('players',num(s.players)); text('pages',`${num(s.pages)} pages processed`); text('clubs',num(s.clubs)); text('divisions',`${s.divisionIndex} / 10 divisions`);
  $('rpm').replaceChildren(document.createTextNode(`${s.requestsLastMinute} `)); const small=document.createElement('small'); small.textContent='/ 59'; $('rpm').append(small);
  text('requests',`${num(s.requests)} requests this scan`); text('retries',num(s.retries)); text('rateLimits',num(s.rateLimits));
  text('published',date(s.lastPublishedAt)); text('synced',date(s.lastSyncedAt)); text('completed',num(s.completedScans)); text('duration',duration(s.lastDurationMs===null?null:s.lastDurationMs/1000)); text('destination',s.syncTarget);
  text('activeTime',duration(s.activeMs/1000)); text('lastRequest',`${s.lastStatus===null?'':`HTTP ${s.lastStatus} · `}${s.lastRequest||'No request yet'}`);
  text('totals',`Lifetime: ${num(s.totalRequests)} requests · ${num(s.totalRetries)} retries · ${num(s.totalRateLimits)} rate limits`);
  $('error').hidden=!s.lastError; text('error',s.lastError||'');
  const cooldown=Math.max(0,Math.ceil((s.cooldownUntil-Date.now())/1000));
  text('cooldown',cooldown?`Rate-limit cooldown · ${cooldown}s remaining`:'No rate-limit cooldown');
  text('loop',s.mode==='running'?'Continuous loop · next scan starts after sync':s.mode==='paused'?'Loop paused · checkpoint preserved':'Loop stopped');
  $('events').replaceChildren();
  for(const event of s.events) {const li=document.createElement('li'),time=document.createElement('time'),message=document.createElement('span');time.dateTime=event.at;time.textContent=new Date(event.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});message.textContent=event.message;li.append(time,message);$('events').append(li);}
  if(!s.events.length){const li=document.createElement('li');li.textContent='No activity yet.';$('events').append(li);}
}
async function api(path,method='GET') {
  const response=await fetch(`/api/${path}`,{method,headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok) {if(response.status===401){sessionStorage.removeItem('cup-scanner-key');token='';$('login').hidden=false;$('dashboard').hidden=true;}throw new Error(response.status===401?'The access key was not accepted.':`Connection failed (HTTP ${response.status}).`);}
  return response.json();
}
async function poll() {
  clearTimeout(timer);
  if(!token)return;
  try {render(await api('status'));text('connection','● Connected · refreshes every 2s');if(!pending)text('notice','');}
  catch(error){text('connection','○ Disconnected');text('notice',`${error.message} Displayed data may be stale.`);}
  finally{if(token)timer=setTimeout(poll,2000);}
}
$('loginForm').addEventListener('submit',async event=>{event.preventDefault();token=$('token').value.trim();if(!token)return;sessionStorage.setItem('cup-scanner-key',token);$('token').value='';await poll();});
for(const action of ['start','pause','stop']) $(action).addEventListener('click',async()=>{
  pending=true;clearTimeout(timer);if(lastState)render(lastState);
  try{const s=await api(action,'POST');render(s);text('notice','');}catch(error){text('notice',error.message);}finally{pending=false;if(lastState)render(lastState);timer=setTimeout(poll,500);}
});
$('disconnect').addEventListener('click',()=>{token='';sessionStorage.removeItem('cup-scanner-key');clearTimeout(timer);$('login').hidden=false;$('dashboard').hidden=true;text('connection','○ Disconnected');text('notice','Dashboard disconnected. The scanner keeps its current state.');});
void poll();
