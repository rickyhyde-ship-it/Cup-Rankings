(function(){
  const key='agentHubStrengthBenchmarks:v1',historyKey='agentHubStrengthSnapshots:v1';
  let saved=[],history={},snapshot=null,metric='top11',mode='total',storageNotice='';
  try{saved=JSON.parse(localStorage.getItem(key)||'[]');history=JSON.parse(localStorage.getItem(historyKey)||'{}')}catch(_){}
  // Numeric tuples avoid storing two copies of every club name and field name.
  for(const field of ['current','previous'])if(Array.isArray(history?.[field]?.rows)){const entry=history[field];history[field]={updatedAt:entry.updatedAt,results:entry.rows.filter(Array.isArray).map(([clubId,playerCount,top11,top16,topFull,clubName])=>({clubId,playerCount,top11,top16,topFull,clubName}))};}
  function storeHistory(){const packed={version:2};for(const field of ['current','previous']){const entry=history[field];packed[field]=entry?{updatedAt:entry.updatedAt,rows:entry.results.map(c=>[c.clubId,c.playerCount,c.top11,c.top16,c.topFull,...(saved.some(id=>String(id)===String(c.clubId))?[c.clubName]:[])])}:null;}localStorage.setItem(historyKey,JSON.stringify(packed));}
  if(!Array.isArray(saved))saved=[];if(!history||typeof history!=='object')history={};
  for(const field of ['current','previous'])if(history[field]&&(!Array.isArray(history[field].results)||!history[field].updatedAt))delete history[field];
  const panel=document.createElement('section');panel.className='hub-upgrade-panel';
  panel.innerHTML='<h2>Source & benchmarks</h2><p id="strengthSource" role="status">Waiting for the strength snapshot…</p><details><summary>How rankings are calculated</summary><p>Cup seedings rank eligible clubs by total Top 11 OVR. League Strength ranks clubs within a division by the selected Top 11, Top 16 or Total Squad measure. Total OVR sums player OVR; Average OVR divides by 11, up to 16, or the full player count. Clubs need at least 11 players. Benchmarks below compare ecosystem-wide ranks using the same selected measure. League Search fetches current membership and squad ratings directly from MFL on every search; it never uses these snapshot ratings.</p></details><div class="hub-upgrade-actions"><label>Benchmark club <input id="benchmarkClub" list="benchmarkOptions" placeholder="Club name or ID" autocomplete="off"></label><datalist id="benchmarkOptions"></datalist><button type="button" id="addBenchmark">Save benchmark</button></div><p id="benchmarkNotice" role="status"></p><div class="hub-scroll" tabindex="0" aria-label="Benchmark rankings"><table><thead><tr><th>Club</th><th>Current rank</th><th>Previous rank</th><th>Change</th><th></th></tr></thead><tbody id="benchmarkRows"></tbody></table></div>';
  document.getElementById('live-panel')?.after(panel);
  if(!panel.isConnected)document.getElementById('cup-panel')?.before(panel);
  if(!panel.isConnected)document.querySelector('main')?.prepend(panel);
  if(!panel.isConnected)document.getElementById('status-box').before(panel);
  panel.hidden = true;
  const input=panel.querySelector('input'),notice=panel.querySelector('#benchmarkNotice');
  const value=(club)=>{const total=Number(club[metric])||0;return mode==='average'?Math.round(total/(metric==='top11'?11:metric==='top16'?Math.min(16,club.playerCount):club.playerCount)*10)/10:total};
  function ranks(data){return new Map((data?.results||[]).filter(c=>Number(c.playerCount)>=11).sort((a,b)=>value(b)-value(a)||String(a.clubName).localeCompare(String(b.clubName))).map((c,i)=>[String(c.clubId),i+1]))}
  function render(){if(!snapshot)return;const now=ranks(snapshot),before=ranks(history.previous),rows=panel.querySelector('tbody');rows.replaceChildren();
    for(const id of saved){const club=snapshot.results.find(c=>String(c.clubId)===String(id)),old=history.previous?.results?.find(c=>String(c.clubId)===String(id));const tr=document.createElement('tr');const current=now.get(String(id)),prior=before.get(String(id));
      for(const text of [club?.clubName||old?.clubName||`Club ${id}`,current??'Not ranked',prior??'No baseline',current&&prior?(prior-current>0?`↑ ${prior-current}`:prior-current<0?`↓ ${current-prior}`:'No change'):'—']){const td=document.createElement('td');td.textContent=text;tr.append(td)}
      const td=document.createElement('td'),remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove benchmark ${club?.clubName||id}`);remove.onclick=()=>{saved=saved.filter(x=>String(x)!==String(id));persist();render()};td.append(remove);tr.append(td);rows.append(tr);
    }
    notice.textContent=storageNotice||(history.previous?`Comparing ${history.current.updatedAt} with ${history.previous.updatedAt} · ${metric}, ${mode} OVR · ecosystem ranks`:'Baseline saved on this device. Rank changes will appear when a newer snapshot is loaded.');
  }
  function persist(){try{localStorage.setItem(key,JSON.stringify(saved));storageNotice='';return true}catch(_){storageNotice='Could not save benchmarks on this device.';notice.textContent=storageNotice;return false}}
  input.oninput=()=>{const q=input.value.trim().toLowerCase();const list=panel.querySelector('datalist');list.replaceChildren();for(const c of (snapshot?.results||[]).filter(c=>`${c.clubName} ${c.clubId}`.toLowerCase().includes(q)).slice(0,20)){const o=document.createElement('option');o.value=String(c.clubId);o.label=c.clubName;list.append(o)}};
  panel.querySelector('#addBenchmark').onclick=()=>{const q=input.value.trim().toLowerCase(),club=snapshot?.results.find(c=>String(c.clubId)===q||String(c.clubName).toLowerCase()===q);if(!club){notice.textContent='Choose a club from the snapshot by name or ID.';return}saved=[...new Set([...saved.map(String),String(club.clubId)])];if(persist()){input.value='';render()}};
  window.AgentStrengthBenchmarks={update(next,nextMetric,nextMode,source,view){panel.hidden=view==='live';if(!next)return;snapshot=next;metric=nextMetric;mode=nextMode;
    if(next.updatedAt&&history.current?.updatedAt!==next.updatedAt){const compact={updatedAt:next.updatedAt,results:next.results.map(c=>({clubId:c.clubId,clubName:c.clubName,playerCount:c.playerCount,top11:c.top11,top16:c.top16,topFull:c.topFull}))};history={previous:history.current||null,current:compact};try{storeHistory();storageNotice='';}catch(_){storageNotice='Snapshot comparison is available for this session only: browser storage is full or blocked. League lookup still works.'}}
    const time=Date.parse(next.updatedAt),age=Number.isFinite(time)?Math.max(0,Math.floor((Date.now()-time)/86400000)):null;
    panel.querySelector('#strengthSource').textContent=`${source} · ${next.updatedAt||'Snapshot date unknown'} · ${age===null?'Age unknown':`${age} days old${age>7?' — stale':''}`} · ${view==='live'?'Live search uses fresh API ratings':'Snapshot ratings; not a live player feed'}`;render();
  }};
})();
