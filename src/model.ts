export const REQUEST_INTERVAL_MS = 1018; // 59 calls in every rolling minute, including retries.
export const RATE_LIMIT_COOLDOWN_MS = 15_000;
export const PAGE_SIZE = 1500;
export const DIVISIONS = ['Diamond','Platinum','Gold','Silver','Bronze','Iron','Stone','Ice','Spark','Flint'].map((name, i) => ({ id: i + 1, name }));
export type Club = { clubId: number; clubName: string; division: number; mainColor: string; secondaryColor: string };
export type Player = { id: number; metadata?: { overall?: number; retirementYears?: number }; activeContract?: { club?: { id: number; name?: string; division?: number; mainColor?: string; secondaryColor?: string } } };
export type Result = Club & { playerCount: number; top11: number; top16: number; topFull: number; retirements: { none: number; yellow: number; orange: number; red: number } };
export type ScanState = {
  mode: 'stopped' | 'running' | 'paused'; stage: 'catalog' | 'players' | 'publish' | 'sync';
  generation: number; cycle: number; completedScans: number; divisionIndex: number;
  cursor: number | null; pages: number; players: number; unassigned: number; clubs: number;
  requests: number; retries: number; rateLimits: number; consecutiveFailures: number;
  requestTimes: number[]; nextRequestAt: number; cooldownUntil: number; startedAt: number | null;
  lastPublishedAt: string | null; lastSyncedAt: string | null; previousPages: number | null;
  lastError: string | null; lastRequest: string | null; lastStatus: number | null;
  lastDurationMs: number | null; activeMs: number; activeSince: number | null;
  totalRequests: number; totalRetries: number; totalRateLimits: number;
  events: { at: string; message: string }[];
};
export function initialState(): ScanState {
  return { mode:'stopped', stage:'catalog', generation:0, cycle:0, completedScans:0, divisionIndex:0,
    cursor:null, pages:0, players:0, unassigned:0, clubs:0, requests:0, retries:0, rateLimits:0,
    consecutiveFailures:0, requestTimes:[], nextRequestAt:0, cooldownUntil:0, startedAt:null,
    lastPublishedAt:null, lastSyncedAt:null, previousPages:null, lastError:null, lastRequest:null,
    lastStatus:null, lastDurationMs:null, activeMs:0, activeSince:null, totalRequests:0,
    totalRetries:0, totalRateLimits:0, events:[] };
}
export function nextCallAt(state: ScanState, now: number): number {
  const recent = state.requestTimes.filter(t => t > now - 60_000);
  return Math.max(now, state.nextRequestAt, state.cooldownUntil, recent.length >= 59 ? recent[recent.length - 59] + 60_001 : 0);
}
export function rateLimited(status: number, body: string): boolean {
  return status === 429 || (status === 403 && /rate.?limit|too many requests|throttl/i.test(body));
}
export function resultsFor(clubs: Club[], players: { club_id: number; overall: number; retirement: number }[]): Result[] {
  const grouped = new Map<number, typeof players>();
  for (const player of players) { const group = grouped.get(player.club_id) || []; group.push(player); grouped.set(player.club_id, group); }
  return clubs.map(club => {
    const squad = (grouped.get(club.clubId) || []).sort((a,b) => b.overall-a.overall);
    const retirements = { none:0, yellow:0, orange:0, red:0 };
    for (const p of squad) retirements[p.retirement === 3 ? 'yellow' : p.retirement === 2 ? 'orange' : p.retirement === 1 ? 'red' : 'none']++;
    const sum = (n: number) => squad.slice(0,n).reduce((s,p)=>s+p.overall,0);
    return {...club, playerCount:squad.length, top11:sum(11), top16:sum(16), topFull:sum(squad.length), retirements};
  });
}
