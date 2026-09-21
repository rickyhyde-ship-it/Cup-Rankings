// Insert inside the Hub strength tool's existing closure, replacing fetchLiveJson.
let liveRequestQueue = Promise.resolve();
let liveNextRequestAt = 0;
let liveCooldownUntil = 0;
function liveWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const aborted = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', aborted, { once:true });
  });
}
function fetchLiveJson(path, signal, attempts = 3) {
  const task = liveRequestQueue.catch(() => {}).then(async () => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await liveWait(Math.max(liveNextRequestAt, liveCooldownUntil) - Date.now(), signal);
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      liveNextRequestAt = Date.now() + 1018;
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          cache:'no-store', headers:{Accept:'application/json'},
          signal:AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
        });
        const body = await response.text();
        const limited = response.status === 429 || (response.status === 403 && /rate.?limit|too many requests|throttl/i.test(body));
        if (limited) liveCooldownUntil = Date.now() + 15000;
        if (!response.ok) {
          const error = new Error(limited ? 'MFL rate limit detected. Retrying after 15 seconds.' : `MFL API returned ${response.status}. Live ratings could not be loaded.`);
          error.status = response.status;
          error.retryable = limited || response.status >= 500;
          throw error;
        }
        return JSON.parse(body);
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        lastError = error;
        if (error.retryable === false || attempt === attempts) throw error;
      }
    }
    throw lastError;
  });
  liveRequestQueue = task.catch(() => {});
  return task;
}
async function fetchClubLiveStrength(club, signal) {
  const clubId = Number(club?.id || club?.clubId);
  if (!Number.isSafeInteger(clubId) || clubId <= 0) throw new Error('Invalid club ID in league membership');
  const payload = await fetchLiveJson(`/clubs/${clubId}/players`, signal);
  const records = Array.isArray(payload) ? payload : payload?.players || payload?.items || payload?.value;
  if (!Array.isArray(records)) throw new Error(`Invalid live squad response for ${club.name || clubId}`);
  const seen = new Set(), group = {club,overalls:[],retirements:{none:0,yellow:0,orange:0,red:0}};
  for (const record of records) {
    const player = record?.player || record;
    const id = Number(player?.id);
    if (Number.isSafeInteger(id)) { if (seen.has(id)) continue; seen.add(id); }
    const overall = Number(player?.metadata?.overall ?? player?.overall);
    if (!Number.isFinite(overall) || overall <= 0) throw new Error(`A live rating is missing for ${club.name || clubId}. Try again.`);
    group.overalls.push(overall);
    const years = Number(player?.metadata?.retirementYears);
    group.retirements[years===3?'yellow':years===2?'orange':years===1?'red':'none']++;
  }
  return clubResultFromPlayerGroup(group, club);
}
