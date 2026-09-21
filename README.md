# Cup Rankings on Cloudflare

Dashboard: https://cup-rankings-scanner.ricky-hyde-selling.workers.dev/

Public snapshot: https://cup-rankings-scanner.ricky-hyde-selling.workers.dev/league-cup-strengths-data.json

The Agents Hub reads this feed for Cup Seedings and League Strengths. It checks for newer completed snapshots every 60 seconds while visible. Its existing GitHub and bundled JSON remain fallbacks until the first successful scan or during an outage. The control dashboard is hosted separately on Cloudflare.

**League Search is always live.** Every submitted search fetches current league membership and `/clubs/{id}/players` from MFL, calculating current ratings and retirements without using snapshot ratings. Repeat searches refetch squads with `cache: no-store`. Failed live requests show an error instead of substituting old data. Browser live requests have their own sequential 59/min pacing and 15-second rate-limit cooldown; the Cloudflare scanner's global budget is independent of visitors' browser requests.

`integration/wordpress/` contains the two updated production theme files for `tools/league-cup-strengths/`. Keep the existing theme assets and bundled snapshot alongside them. The standalone snippets in `integration/` document the live-request implementation.

## Operation

- **Start** starts the continuous loop. After Pause it resumes the checkpoint; after Stop it starts a fresh scan.
- **Pause** preserves the current scan and cancels scheduled work. An already-sent request can finish, but its response cannot advance the paused scan.
- **Stop** invalidates the unfinished scan and keeps the last published snapshot available.
- Closing the dashboard does not stop scanning. Enter the dashboard access key to reconnect.
- A singleton Durable Object owns the MFL request budget: at least 1,018 ms between starts and at most 59 attempts per rolling minute. Failed requests and retries count. The budget survives pause, stop, scan boundaries and restarts.
- HTTP 429, or a 403 response explicitly identifying throttling, triggers a **15-second** cooldown. Other failures retry at normal request pacing. Plain access-denied 403 responses are shown as access errors.
- A complete scan collects all ten division leaderboards and cursor-paginated contracted players, deduplicates players, calculates Top 11 / Top 16 / full-squad OVR and retirement counts, then atomically publishes the snapshot. The next scan starts automatically after publication/sync.
- SQLite snapshot chunks stay below row limits; public JSON streams over RPC. Partial scans never replace the published feed. A one-minute watchdog restores a missing alarm only when the saved mode is running.
- ETA is approximate. The first scan uses the repository's August 2026 snapshot size (152,767 players); later scans use the previous page count and current observed pace. Retries, API latency and roster changes affect it.

## Deployment

Requires Node.js 22+ and pnpm. Authentication uses Wrangler's normal Cloudflare login.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Set ADMIN_TOKEN to a securely generated random value in .dev.vars.
pnpm types
pnpm check
pnpm test
pnpm exec wrangler deploy --dry-run
pnpm deploy
pnpm exec wrangler secret put ADMIN_TOKEN
```

Keep `.dev.vars` out of Git. `ADMIN_TOKEN` protects status and Start/Pause/Stop; the completed rankings feed is public. No control credentials are included in the Hub theme or public dashboard JavaScript.

`MFL_API_BASE` is `https://api.playmfl.com`. No legacy AWS endpoint or intermediary proxy is used by the scanner. The preserved GitHub HTML report loads the published feed and opens the Cloudflare dashboard for updates, preventing an independent browser scanner from bypassing the service's request budget.

Optional GitHub JSON mirroring is available by setting `SYNC_GITHUB` to `true` and setting a `GITHUB_TOKEN` secret with Contents write permission for this repository. The live Hub integration uses the Cloudflare feed directly and does **not** require this token. If optional mirroring is enabled, failed GitHub writes retry before the next scan starts.

The Vitest Workers pool currently bundles an August runtime, so test configuration uses its supported compatibility date; deployment uses September 21, 2026. Tests exercise real Durable Object storage, request budgets, retries, pause/stop races, atomic publication, Unicode/multi-megabyte snapshots and loop restart.

## Initial deployment status — 2026-09-21

Dashboard and live Hub feed integration deployed. MFL returned HTTP 403 access-denied responses from both the development machine and the deployed Worker. Verification was stopped; no replacement snapshot was published. The prior Hub snapshot remains available. MFL must permit these API requests before an end-to-end production scan can complete. Do not treat this as a rate limit or work around the access block with another proxy.
