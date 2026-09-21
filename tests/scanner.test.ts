import { describe, it, expect, vi, afterEach } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { initialState, nextCallAt, rateLimited, resultsFor } from '../src/model';

afterEach(()=>vi.restoreAllMocks());
const fresh = () => env.SCANNER.getByName(crypto.randomUUID());
async function step(stub: ReturnType<typeof fresh>) {
  await runInDurableObject(stub,async(instance,ctx)=>{
    instance['state'].nextRequestAt=0; instance['state'].cooldownUntil=0; instance['state'].requestTimes=[];
    await ctx.storage.deleteAlarm(); await instance.alarm(); await ctx.storage.deleteAlarm();
  });
}
async function start(stub:ReturnType<typeof fresh>) {
  await runInDurableObject(stub,async(instance,ctx)=>{ await instance.control('start'); await ctx.storage.deleteAlarm(); });
}
async function readSnapshot(stub:ReturnType<typeof fresh>){const r=await stub.snapshot();return r.ok?await r.text():null;}
const samplePlayer=(id:number,overall=80)=>({id,metadata:{overall,retirementYears:id%4},activeContract:{club:{id:7,name:'Test club',division:1,mainColor:'#abc',secondaryColor:'#def'}}});
describe('request budget',()=>{
  it('caps every rolling minute at 59 across scan restarts and retries',()=>{
    const state=initialState(), times:number[]=[]; let now=0;
    for(let i=0;i<350;i++){now=nextCallAt(state,now);times.push(now);state.requestTimes=times.slice(-65);state.nextRequestAt=now+1018;expect(times.filter(t=>t>now-60000)).toHaveLength(Math.min(i+1,59));}
  });
  it('waits exactly 15 seconds for detected limits and does not treat all 403s as limits',()=>{
    const state=initialState();state.cooldownUntil=15000;
    expect(nextCallAt(state,1000)).toBe(15000);expect(nextCallAt(state,15000)).toBe(15000);
    expect(rateLimited(429,'')).toBe(true);expect(rateLimited(403,'Rate limit exceeded')).toBe(true);
    expect(rateLimited(403,'Sorry, you have been blocked')).toBe(false);expect(rateLimited(503,'Unavailable')).toBe(false);
  });
});
describe('durable scanner',()=>{
  it('requires auth for controls while public feed is read-only',async()=>{
    expect((await SELF.fetch('https://test/api/start',{method:'POST'})).status).toBe(401);
    expect((await SELF.fetch('https://test/api/status',{headers:{Authorization:'Bearer test-key'}})).status).toBe(200);
    expect((await SELF.fetch('https://test/league-cup-strengths-data.json',{method:'POST'})).status).toBe(405);
  });
  it('retries failed requests without advancing and preserves the checkpoint on pause',async()=>{
    const stub=fresh();await start(stub);vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('Unavailable',{status:503}));
    await step(stub);let state=await stub.status();expect(state.requests).toBe(1);expect(state.retries).toBe(1);expect(state.divisionIndex).toBe(0);expect(state.cooldownUntil).toBe(0);
    await stub.control('pause');await runInDurableObject(stub,instance=>instance.alarm());expect((await stub.status()).requests).toBe(1);
    await runInDurableObject(stub,async(instance,ctx)=>{await instance.control('start');await ctx.storage.deleteAlarm();});
    state=await stub.status();expect(state.cycle).toBe(1);expect(state.mode).toBe('running');
    await stub.control('stop');await start(stub);expect((await stub.status()).cycle).toBe(2);await stub.control('stop');
  });
  it('persists a 15-second cooldown for HTTP 429 including the retry attempt',async()=>{
    const stub=fresh();await start(stub);vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('limit',{status:429}));
    const before=Date.now();await step(stub);const state=await stub.status();
    expect(state.rateLimits).toBe(1);expect(state.requests).toBe(1);expect(state.cooldownUntil).toBeGreaterThanOrEqual(before+15000);expect(state.cooldownUntil).toBeLessThanOrEqual(Date.now()+15000);
    await runInDurableObject(stub,instance=>instance.alarm());expect((await stub.status()).requests).toBe(1);await stub.control('stop');
  });
  it('discards a late response after stop and does not restart',async()=>{
    const stub=fresh();await start(stub);
    await runInDurableObject(stub,async(instance,ctx)=>{
      vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{await instance.control('stop');return Response.json({clubs:[{id:7,name:'Late',division:1}]});});
      await instance.alarm();expect((await instance.status()).divisionIndex).toBe(0);expect((await instance.status()).mode).toBe('stopped');expect(await ctx.storage.getAlarm()).toBe(null);
    });
  });
  it('publishes accurate full results atomically, syncs, then starts another scan',async()=>{
    const stub=fresh();await start(stub);
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{
      const url=new URL(String(input));return Response.json(url.pathname==='/players'?Array.from({length:18},(_,i)=>samplePlayer(i+1,99-i)):{clubs:url.searchParams.get('division')==='1'?[{id:7,name:'Test club',division:1}]:[]});
    });
    for(let i=0;i<10;i++)await step(stub);
    expect((await stub.status()).stage).toBe('players');expect(await readSnapshot(stub)).toBe(null);
    await step(stub);expect((await stub.status()).stage).toBe('publish');expect(await readSnapshot(stub)).toBe(null);
    await step(stub);const snapshot=JSON.parse((await readSnapshot(stub))!);expect(snapshot.results[0]).toMatchObject({playerCount:18,top11:1034,top16:1464,topFull:1629});
    expect(snapshot.results[0].retirements).toEqual({none:4,yellow:4,orange:5,red:5});
    await step(stub);expect((await stub.status()).completedScans).toBe(1);expect((await stub.status()).cycle).toBe(2);expect((await stub.status()).stage).toBe('catalog');
    expect(JSON.parse((await readSnapshot(stub))!).updatedAt).toBe(snapshot.updatedAt);
    await stub.control('stop');expect(JSON.parse((await readSnapshot(stub))!).results).toHaveLength(1);
  });
  it('rolls back malformed pages and does not publish partial data',async()=>{
    const stub=fresh();await start(stub);
    await runInDurableObject(stub,async(instance,ctx)=>{instance['state'].stage='players';instance['state'].clubs=1;instance['save']();await ctx.storage.deleteAlarm();});
    vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json([samplePlayer(1),{id:2,metadata:{overall:'bad'}}]));
    await step(stub);expect((await stub.status()).players).toBe(0);expect((await stub.status()).pages).toBe(0);expect(await readSnapshot(stub)).toBe(null);
    await runInDurableObject(stub,async(_instance,ctx)=>{expect(ctx.storage.sql.exec('SELECT * FROM players').toArray()).toHaveLength(0);});
    await stub.control('stop');
  });
  it('recovers a missing alarm only when running',async()=>{
    const stub=fresh();await start(stub);
    await runInDurableObject(stub,instance=>{instance['state'].nextRequestAt=Date.now()+60000;});
    await stub.recover();
    await runInDurableObject(stub,async(_instance,ctx)=>{expect(await ctx.storage.getAlarm()).not.toBe(null);});
    await stub.control('pause');await stub.recover();
    await runInDurableObject(stub,async(_instance,ctx)=>{expect(await ctx.storage.getAlarm()).toBe(null);});
  });
  it('streams a multi-megabyte snapshot without exceeding SQLite row limits',async()=>{
    const stub=fresh();
    await runInDurableObject(stub,(instance,ctx)=>{
      ctx.storage.transactionSync(()=>{
        for(let id=1;id<=11500;id++)ctx.storage.sql.exec('INSERT INTO clubs VALUES (?, ?)',id,JSON.stringify({clubId:id,clubName:`Club ${id} — Équipe ⚽`,division:1,mainColor:'#abc',secondaryColor:'#def'}));
        instance['state'].startedAt=Date.now();
        instance['publish']();
      });
      expect(ctx.storage.sql.exec('SELECT id FROM snapshots').toArray().length).toBeGreaterThan(1);
    });
    const data=await readSnapshot(stub);
    expect(new TextEncoder().encode(data!).byteLength).toBeGreaterThan(2*1024*1024);
    expect(JSON.parse(data!).results).toHaveLength(11500);
    expect(JSON.parse(data!).results[11499].clubName).toBe('Club 11500 — Équipe ⚽');
  });
});
