import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('integration/wordpress/index.html','utf8');
for(const path of ['integration/wordpress/index.html','index (4).html'])for(const m of readFileSync(path,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
const helpers=source.slice(source.indexOf('      function clubResultFromPlayerGroup('),source.indexOf('      function avg('));
const loader=source.slice(source.indexOf('      async function loadLiveLeague('),source.indexOf('      function renderAll('));
function harness(handler){
 let time=0;const calls=[],statuses=[];
 const context=vm.createContext({URL,AbortController,AbortSignal,DOMException,Response,console,Map,Set,
  Date:class extends Date {static now(){return time;}},
  setTimeout:(fn,ms)=>{time+=Math.max(0,ms);queueMicrotask(fn);return 1;},clearTimeout:()=>{},
  API_BASE:'https://api.playmfl.com',MAX_LIVE_LEAGUE_CLUBS:96,
  state:{liveLoadRun:0,snapshot:{results:[{clubId:7,top11:99999}]},liveClubs:[]},
  els:{liveResults:{innerHTML:''},liveLoadButton:{},liveSearch:{}},
  normalizeArray:(p,keys)=>Array.isArray(p)?p:keys.map(k=>p[k]).find(Array.isArray)||[],
  setLiveStatus:(message,state)=>statuses.push({message,state}),formatNumber:String,
  renderLiveResults:()=>{},updateLiveLoadButton:()=>{},
  fetch:async(url,options)=>{calls.push({url,time,cache:options.cache});return handler(url,options,calls,context);}
 });
 vm.runInContext(helpers+'\n'+loader,context);return {context,calls,statuses};
}
let rating=80,playerRequests=0;
const fixture=(url)=>{if(url.endsWith('/competitions/123'))return Response.json({id:123,type:'LEAGUE',name:'Live league'});if(url.endsWith('/competitions/123/clubs'))return Response.json([{id:7,name:'Live club',division:1}]);if(url.endsWith('/clubs/7/players')){playerRequests++;return Response.json(Array.from({length:18},(_,i)=>({player:{id:i+1,metadata:{overall:rating,retirementYears:i%4}}})));}throw Error('Unexpected '+url);};
const h=harness(fixture);await h.context.loadLiveLeague('123');assert.equal(h.context.state.liveClubs[0].top11,880);assert.equal(h.context.state.liveClubs[0].top16,1280);assert.equal(h.context.state.liveClubs[0].topFull,1440);rating=90;h.context.state.snapshot=null;await h.context.loadLiveLeague('123');assert.equal(h.context.state.liveClubs[0].top11,990);assert.equal(playerRequests,2);assert(h.calls.every(c=>c.cache==='no-store'));assert(h.statuses.at(-1).message.includes('fresh MFL squad ratings'));console.log('PASS each search fetches fresh squads; ignores stored ratings; works without a snapshot');
const bad=harness(url=>url.endsWith('/players')?Response.json({invalid:true}):fixture(url));await bad.context.loadLiveLeague('123');assert.equal(bad.context.state.liveClubs.length,0);assert.equal(bad.statuses.at(-1).state,'error');console.log('PASS invalid live data fails visibly with no snapshot substitution');
const retry=harness((_url,_options,calls)=>calls.length===1?new Response('Too many requests',{status:429}):Response.json([]));await retry.context.fetchLiveJson('/players');assert.equal(retry.calls[1].time-retry.calls[0].time,15000);console.log('PASS rate limit uses exactly 15 seconds');
const transient=harness((_url,_options,calls)=>calls.length===1?new Response('Unavailable',{status:503}):Response.json([]));await transient.context.fetchLiveJson('/players');assert.equal(transient.calls[1].time-transient.calls[0].time,1018);console.log('PASS ordinary failure retries at request pacing with no extra cooldown');
const paced=harness(()=>Response.json([]));for(let i=0;i<120;i++)await paced.context.fetchLiveJson('/players');for(const c of paced.calls)assert(paced.calls.filter(x=>x.time<=c.time&&x.time>c.time-60000).length<=59);console.log('PASS live request queue caps all rolling minutes at 59');
const cancel=harness((url,_opts,_calls,ctx)=>{if(url.endsWith('/players'))ctx.state.liveLoadRun++;return fixture(url);});await cancel.context.loadLiveLeague('123');assert.equal(cancel.context.state.liveClubs.length,0);console.log('PASS superseded searches cannot publish late results');
assert(!source.includes('snapshotByClubId'));assert(!source.includes('refreshedClubs'));console.log('PASS snapshot refresh cannot overwrite live League Search');
