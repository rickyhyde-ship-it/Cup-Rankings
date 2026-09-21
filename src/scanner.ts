import { DurableObject } from 'cloudflare:workers';
import { Club, Player, ScanState, DIVISIONS, PAGE_SIZE, REQUEST_INTERVAL_MS, RATE_LIMIT_COOLDOWN_MS, initialState, nextCallAt, rateLimited, resultsFor } from './model';

const MFL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class RankingScanner extends DurableObject<Env> {
  private state!: ScanState;
  private busy = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS clubs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, club_id INTEGER NOT NULL, overall REAL NOT NULL, retirement INTEGER NOT NULL)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
      const row = ctx.storage.sql.exec<{data:string}>('SELECT data FROM settings WHERE id=1').toArray()[0];
      this.state = row ? JSON.parse(row.data) : initialState();
    });
  }
  private save() { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO settings VALUES (1, ?)', JSON.stringify(this.state)); }
  private event(message: string) {
    this.state.events.unshift({at:new Date().toISOString(), message});
    this.state.events = this.state.events.slice(0,50);
  }
  private newCycle() {
    const s = this.state;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM players');
      this.ctx.storage.sql.exec('DELETE FROM clubs');
      Object.assign(s, { stage:'catalog', generation:s.generation+1, cycle:s.cycle+1,
        divisionIndex:0, cursor:null, pages:0, players:0, unassigned:0, clubs:0, requests:0,
        retries:0, rateLimits:0, consecutiveFailures:0, startedAt:Date.now(), lastError:null,
        activeMs:0, activeSince:Date.now() });
      this.event(`Scan ${s.cycle} started`);
      this.save();
    });
  }
  async control(action: string) {
    const s = this.state;
    if (action === 'start') {
      if (s.mode === 'running') return this.status();
      if (s.mode === 'stopped') this.newCycle();
      s.mode = 'running'; s.activeSince = Date.now();
      this.event('Scanner running'); this.save();
      await this.ctx.storage.setAlarm(Math.max(Date.now()+1, nextCallAt(s,Date.now())));
    } else if (action === 'pause' || action === 'stop') {
      if (s.activeSince !== null) s.activeMs += Date.now()-s.activeSince;
      s.activeSince = null;
      if (action === 'pause' && s.mode === 'stopped') return this.status();
      s.mode = action === 'pause' ? 'paused' : 'stopped';
      // Invalidate in-flight responses before changing or resuming the job.
      s.generation++;
      this.event(action === 'pause' ? 'Paused; checkpoint saved' : 'Stopped; last published snapshot retained');
      this.save(); await this.ctx.storage.deleteAlarm();
    } else throw new Error('Unknown control action');
    return this.status();
  }
  async status() {
    const s = this.state, now = Date.now();
    const activeMs = s.activeMs + (s.activeSince === null ? 0 : now-s.activeSince);
    const successfulSteps = s.divisionIndex+s.pages;
    // Historical repository snapshot: 152,767 contracted players on 2026-08-12.
    const expectedSteps = 10+(s.previousPages ?? 102);
    const remaining = Math.max(0,expectedSteps-successfulSteps);
    const etaSeconds = s.mode !== 'running' || remaining === null || s.stage === 'sync' ? null :
      Math.ceil((remaining*Math.max(REQUEST_INTERVAL_MS,activeMs/Math.max(1,successfulSteps)) + Math.max(0,s.cooldownUntil-now))/1000);
    return {...s, busy:this.busy, activeMs, etaSeconds, etaBasis:s.previousPages === null ? 'Initial estimate from the August snapshot; may change' : 'Estimated from previous scan size and current pace',
      requestsLastMinute:s.requestTimes.filter(t=>t>now-60_000).length, nextCallAt:nextCallAt(s,now),
      progressPercent:Math.min(99,Math.round(successfulSteps/expectedSteps*100)),
      syncTarget:this.env.SYNC_GITHUB === 'true' ? 'Cloudflare + GitHub Pages' : 'Cloudflare snapshot feed',
      snapshotAvailable:!!this.ctx.storage.sql.exec('SELECT id FROM snapshots WHERE id=1').toArray().length };
  }
  private snapshotText() {
    const rows = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM snapshots ORDER BY id').toArray();
    return rows.length ? rows.map(row=>row.data).join('') : null;
  }
  async snapshot() {
    const data = this.snapshotText();
    // Response bodies stream over RPC; large snapshots must not be RPC string values.
    return new Response(data ?? JSON.stringify({error:'No complete scan published yet'}),{
      status:data ? 200 : 503, headers:{'Content-Type':'application/json; charset=utf-8'}
    });
  }
  async recover() {
    if (this.state.mode === 'running' && !this.busy && await this.ctx.storage.getAlarm() === null)
      await this.ctx.storage.setAlarm(Math.max(Date.now()+1,nextCallAt(this.state,Date.now())));
  }
  private path() {
    const s = this.state;
    if (s.stage === 'catalog') return `/leaderboards/clubs/global?division=${DIVISIONS[s.divisionIndex].id}&sort=nbMflPoints&sortOrder=DESC&limit=20000`;
    const params = new URLSearchParams({limit:String(PAGE_SIZE),sorts:'metadata.overall',sortsOrders:'DESC',excludingMflOwned:'false',isFreeAgent:'false'});
    if (s.cursor !== null) params.set('beforePlayerId',String(s.cursor));
    return `/players?${params}`;
  }
  private acceptCatalog(data: unknown) {
    const s = this.state;
    if (!data || typeof data !== 'object' || !('clubs' in data) || !Array.isArray(data.clubs)) throw new Error('Invalid club catalogue response');
    if (data.clubs.length >= 20000) throw new Error('Club catalogue reached page limit; refusing a truncated snapshot');
    const clubs: Club[] = data.clubs.map((value: Record<string,unknown>) => {
      const id = Number(value.id), division = Number(value.division || DIVISIONS[s.divisionIndex].id);
      if (!Number.isSafeInteger(id) || id<=0 || division<1 || division>10) throw new Error('Invalid club identity in catalogue');
      return {clubId:id,clubName:String(value.name||`Club ${id}`),division,mainColor:'#333',secondaryColor:'#555'};
    });
    this.ctx.storage.transactionSync(() => {
      for (const club of clubs) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO clubs VALUES (?, ?)',club.clubId,JSON.stringify(club));
      s.divisionIndex++; s.clubs = this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM clubs').one().n;
      this.event(`${DIVISIONS[s.divisionIndex-1].name}: ${clubs.length} clubs`);
      if (s.divisionIndex === DIVISIONS.length) {
        if (!s.clubs) throw new Error('No clubs found; keeping the last published snapshot');
        s.stage = 'players'; this.event('Fetching contracted players');
      }
      this.save();
    });
  }
  private acceptPlayers(data: unknown) {
    const s = this.state;
    if (!Array.isArray(data)) throw new Error('Invalid player response');
    if (data.length>PAGE_SIZE) throw new Error('Player response exceeds page limit');
    const batch: Player[] = data;
    const cursor = batch.length ? Number(batch[batch.length-1].id) : s.cursor;
    if (batch.length && (!Number.isSafeInteger(cursor) || cursor === s.cursor)) throw new Error('Player pagination cursor did not advance');
    for (const p of batch) {
      if (!Number.isSafeInteger(Number(p?.id)) || Number(p.id)<=0 || !Number.isFinite(Number(p.metadata?.overall))) throw new Error('Invalid player data; retrying page');
      if (p.activeContract?.club && (!Number.isSafeInteger(Number(p.activeContract.club.id)) || Number(p.activeContract.club.id)<=0)) throw new Error('Invalid player club');
    }
    // Roll back both rows and cursor if validation or storage fails.
    this.ctx.storage.transactionSync(() => {
      let added = 0;
      for (const p of batch) {
        const club = p.activeContract?.club;
        const inserted = this.ctx.storage.sql.exec('INSERT OR IGNORE INTO players VALUES (?, ?, ?, ?) RETURNING id',Number(p.id),Number(club?.id||0),Number(p.metadata?.overall),Number(p.metadata?.retirementYears||0)).toArray();
        if (inserted.length) { added++; if (!club) s.unassigned++; }
        if (club) {
          const row = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM clubs WHERE id=?',Number(club.id)).toArray()[0];
          if (row) { const old: Club = JSON.parse(row.data); this.ctx.storage.sql.exec('UPDATE clubs SET data=? WHERE id=?',JSON.stringify({...old,clubName:club.name||old.clubName,mainColor:club.mainColor||old.mainColor,secondaryColor:club.secondaryColor||old.secondaryColor,division:Number(club.division||old.division)}),Number(club.id)); }
        }
      }
      if (batch.length && added === 0) throw new Error('Pagination returned only duplicates; refusing incomplete results');
      s.players += added; s.pages++; s.cursor = cursor;
      if (batch.length<PAGE_SIZE) {
        if (!s.players) throw new Error('No contracted players found; keeping last published snapshot');
        s.stage = 'publish'; this.event(`All players collected: ${s.players.toLocaleString()}`);
      }
      this.save();
    });
  }
  private publish() {
    const s = this.state;
    const clubs = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM clubs ORDER BY id').toArray().map(row=>JSON.parse(row.data) as Club);
    const players = this.ctx.storage.sql.exec<{club_id:number;overall:number;retirement:number}>('SELECT club_id, overall, retirement FROM players').toArray();
    const updatedAt = new Date().toISOString();
    const data = JSON.stringify({schemaVersion:3, updatedAt, scanStartedAt:new Date(s.startedAt!).toISOString(),source:{repository:this.env.GITHUB_REPOSITORY,api:this.env.MFL_API_BASE},divisions:DIVISIONS,results:resultsFor(clubs,players),failed:[],playerCountFetched:s.players,unassignedPlayerCount:s.unassigned,requestCount:s.requests});
    this.ctx.storage.transactionSync(() => {
      // Each SQLite row is limited to 2 MB. Chunk the full document and swap atomically.
      this.ctx.storage.sql.exec('DELETE FROM snapshots');
      for(let offset=0,id=1;offset<data.length;id++) {
        let end=Math.min(data.length,offset+200000);
        const last=data.charCodeAt(end-1);
        if(end<data.length && last>=0xD800 && last<=0xDBFF) end--;
        this.ctx.storage.sql.exec('INSERT INTO snapshots VALUES (?, ?)',id,data.slice(offset,end));
        offset=end;
      }
      s.lastPublishedAt = updatedAt; s.stage = 'sync'; this.event('Complete snapshot published to Cloudflare'); this.save();
    });
  }
  private async syncGithub(generation: number) {
    if (!this.env.GITHUB_TOKEN) throw new Error('GitHub sync needs the GITHUB_TOKEN secret');
    const url = `https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/contents/league-cup-strengths-data.json`;
    const headers = {Authorization:`Bearer ${this.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'Cup-Rankings-Cloudflare','X-GitHub-Api-Version':'2022-11-28'};
    const existing = await fetch(`${url}?ref=${encodeURIComponent(this.env.GITHUB_BRANCH)}`,{headers,signal:AbortSignal.timeout(20_000)});
    if (!existing.ok && existing.status!==404) throw new Error(`GitHub read failed: HTTP ${existing.status}`);
    const previous = existing.ok ? await existing.json() as {sha:string;content?:string} : null;
    if (this.state.mode!=='running' || generation!==this.state.generation) return false;
    const snapshot = this.snapshotText();
    if (!snapshot) throw new Error('No complete snapshot to sync');
    const bytes = new TextEncoder().encode(snapshot);
    let binary = ''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const content = btoa(binary);
    // Makes retry after an uncertain PUT idempotent.
    if (previous?.content?.replace(/\s/g,'') === content) return true;
    const response = await fetch(url,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({message:`Update strength snapshot ${this.state.lastPublishedAt}`,content,branch:this.env.GITHUB_BRANCH,...(previous?{sha:previous.sha}:{})}),signal:AbortSignal.timeout(20_000)});
    if (!response.ok) throw new Error(`GitHub publish failed: HTTP ${response.status}`);
    await response.arrayBuffer();
    return true;
  }
  async alarm() {
    if (this.state.mode!=='running' || this.busy) return;
    this.busy = true;
    const generation = this.state.generation;
    const checkpoint = structuredClone(this.state);
    try {
      const s = this.state, now = Date.now();
      if (now<nextCallAt(s,now)) return;
      if (s.stage==='publish') { this.publish(); return; }
      if (s.stage==='sync') {
        if (this.env.SYNC_GITHUB==='true' && !await this.syncGithub(generation)) return;
        if (s.mode!=='running' || generation!==s.generation) return;
        s.lastSyncedAt = new Date().toISOString(); s.completedScans++; s.previousPages = s.pages;
        s.lastDurationMs = s.activeMs+(s.activeSince===null?0:Date.now()-s.activeSince);
        this.event(`Scan ${s.cycle} synced; starting next scan`); this.save(); this.newCycle(); return;
      }
      const path = this.path();
      s.requestTimes = s.requestTimes.filter(t=>t>now-60_000); s.requestTimes.push(now);
      s.nextRequestAt = now+REQUEST_INTERVAL_MS; s.requests++; s.totalRequests++; s.lastRequest = path;
      this.save(); // Reservation survives crashes and counts every attempted request.
      const response = await fetch(`${this.env.MFL_API_BASE}${path}`,{
        headers:{Accept:'application/json','User-Agent':MFL_USER_AGENT},
        signal:AbortSignal.timeout(20_000)
      });
      const body = await response.text();
      // Honor a rate limit even when Pause/Stop arrived while the request was in flight.
      if (rateLimited(response.status,body)) {
        s.cooldownUntil=Date.now()+RATE_LIMIT_COOLDOWN_MS; s.rateLimits++; s.totalRateLimits++; this.save();
      }
      if (s.mode!=='running' || generation!==s.generation) return;
      s.lastStatus=response.status;
      if (!response.ok) throw new Error(rateLimited(response.status,body) ? 'MFL rate limit detected; retry in 15 seconds' : `MFL HTTP ${response.status}${response.status===403?' — access denied (not a confirmed rate limit)':''}`);
      const parsed: unknown = JSON.parse(body);
      const beforeAccept = structuredClone(s);
      try { if (s.stage==='catalog') this.acceptCatalog(parsed); else this.acceptPlayers(parsed); }
      catch(error) { this.state = beforeAccept; throw error; }
      this.state.lastError=null; this.state.consecutiveFailures=0; this.save();
    } catch(error) {
      if (this.state.mode==='running' && generation===this.state.generation) {
        this.state.retries++; this.state.totalRetries++; this.state.consecutiveFailures++;
        const message = error instanceof Error ? error.message : String(error);
        this.state.lastError = message;
        if (this.state.consecutiveFailures===1 || this.state.consecutiveFailures%10===0) this.event(message);
        // All ordinary retries use the same request pacing, without extra cooldowns.
        this.state.nextRequestAt=Math.max(this.state.nextRequestAt,Date.now()+REQUEST_INTERVAL_MS);
        this.save();
      }
      console.error(JSON.stringify({event:'scan_retry',cycle:checkpoint.cycle,error:String(error)}));
    } finally {
      this.busy=false;
      if (this.state.mode==='running') await this.ctx.storage.setAlarm(Math.max(Date.now()+1,nextCallAt(this.state,Date.now())));
    }
  }
}
