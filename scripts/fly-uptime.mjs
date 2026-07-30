#!/usr/bin/env node
/**
 * Machine time per day for a Fly app, from Fly's hosted Prometheus.
 *
 * This is the measurement the whole edge-caching effort is judged by, so it lives in the repo
 * rather than being re-derived from memory each time. With `auto_stop_machines = 'suspend'` and
 * `min_machines_running = 0`, any inbound request wakes a dedicated performance-1x core and
 * holds it for Fly's idle window, so "hours up per day" IS the bill, and "wake episodes per
 * day" is the count of things that woke it. See docs/edge-runbook.md for how to read the
 * output, and CONTRIBUTING.md "The edge" for why the edge exists at all.
 *
 *   node scripts/fly-uptime.mjs                       # nickel-bridge, last 10 days
 *   node scripts/fly-uptime.mjs nickel-bridge-demo 14
 *   node scripts/fly-uptime.mjs nickel-bridge --recent # rolling 6h/12h/24h windows
 *
 * Needs FLY_API_TOKEN (org-scoped; `fly tokens create org personal`). Note the Prometheus
 * endpoint wants `Authorization: FlyV1 <token>` — NOT `Bearer`, which 401s.
 *
 * TWO TRAPS, both of which have already produced wrong conclusions here:
 *
 * 1. `count_over_time(fly_instance_up[1d])` under-reported by ~18x. Never use a range
 *    aggregation for this. Ask for the raw range vector (`metric[1d]`) at an instant and count
 *    the samples yourself, which is what this script does.
 *
 * 2. Fly's Prometheus DOWNSAMPLES with age. Yesterday comes back at the true 15s scrape
 *    spacing; three days back it is 30s; a week back 60s — and samples are dropped outright,
 *    not merely thinned, so an old day still under-reports after scaling by its spacing. This
 *    script prints the inferred spacing per row for exactly that reason. **Rows of different
 *    `step` are not comparable.** A before/after comparison must therefore put both sides at
 *    the same age: record the baseline contemporaneously (see docs/edge-runbook.md, which has
 *    the pre-fronting numbers written down for this reason), then measure the after-period
 *    while it is still fresh.
 */

const args = process.argv.slice(2);
const recent = args.includes('--recent');
const positional = args.filter((a) => !a.startsWith('--'));
const app = positional[0] ?? 'nickel-bridge';
const days = Number(positional[1] ?? 10);

const token = process.env.FLY_API_TOKEN;
if (!token) {
  console.error('FLY_API_TOKEN is required (org-scoped: fly tokens create org personal)');
  process.exit(1);
}

const ENDPOINT = 'https://api.fly.io/prometheus/personal/api/v1/query';
/** A gap wider than this many sample intervals means the machine was down in between. */
const GAP_FACTOR = 4;

async function instant(query, time) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('time', String(time));
  const res = await fetch(url, { headers: { Authorization: `FlyV1 ${token}` } });
  if (!res.ok) throw new Error(`Prometheus ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Prometheus: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data.result;
}

/**
 * Sample timestamps for one window, deduped across machines: this app runs exactly one machine
 * (SQLite on a single volume — see CONTRIBUTING.md "Deployment shape"), but a deploy briefly
 * overlaps two, and double-counting those seconds would inflate the day.
 */
async function samples(window, at) {
  const result = await instant(`fly_instance_up{app="${app}"}[${window}]`, at);
  const seen = new Set();
  for (const series of result) for (const [ts] of series.values) seen.add(Math.round(ts));
  return [...seen].sort((a, b) => a - b);
}

/** Modal gap between consecutive samples — the resolution Prometheus actually returned. */
function inferStep(sorted) {
  const counts = new Map();
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap <= 300) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 15;
}

function summarize(sorted) {
  const step = inferStep(sorted);
  let episodes = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] - sorted[i - 1] > step * GAP_FACTOR) episodes++;
  }
  const seconds = sorted.length * step;
  return { step, seconds, episodes };
}

const midnightBefore = (epoch) => Math.floor(epoch / 86400) * 86400;
const now = Math.floor(Date.now() / 1000);

if (recent) {
  console.log(`app=${app}  now=${new Date(now * 1000).toISOString()}\n`);
  console.log('window   up_h   of_window  episodes  mean_min  step');
  for (const window of ['6h', '12h', '24h']) {
    const { step, seconds, episodes } = summarize(await samples(window, now));
    const hours = Number(window.replace('h', ''));
    const mean = episodes ? seconds / episodes / 60 : 0;
    console.log(
      `${window.padEnd(7)} ${(seconds / 3600).toFixed(2).padStart(5)}  ` +
        `${((100 * seconds) / 3600 / hours).toFixed(0).padStart(8)}%  ` +
        `${String(episodes).padStart(8)}  ${mean.toFixed(1).padStart(8)}  ${String(step).padStart(3)}s`,
    );
  }
  process.exit(0);
}

const today = midnightBefore(now);
console.log(`app=${app}  (raw fly_instance_up samples; rows of differing step are NOT comparable)\n`);
console.log('day          up_h  episodes  mean_min  step');
let totalSeconds = 0;
let totalEpisodes = 0;
for (let back = days; back >= 1; back--) {
  const end = today - (back - 1) * 86400;
  const { step, seconds, episodes } = summarize(await samples('1d', end));
  const label = new Date((end - 86400) * 1000).toISOString().slice(0, 10);
  const mean = episodes ? seconds / episodes / 60 : 0;
  console.log(
    `${label}  ${(seconds / 3600).toFixed(2).padStart(5)}  ${String(episodes).padStart(8)}  ` +
      `${mean.toFixed(1).padStart(8)}  ${String(step).padStart(3)}s`,
  );
  totalSeconds += seconds;
  totalEpisodes += episodes;
}
console.log(
  `\nmean over ${days} days: ${(totalSeconds / 3600 / days).toFixed(2)} h/day, ` +
    `${(totalEpisodes / days).toFixed(1)} wake episodes/day, ` +
    `mean episode ${totalEpisodes ? (totalSeconds / totalEpisodes / 60).toFixed(1) : '0'} min`,
);
console.log('(that mean mixes resolutions — quote same-step days, or use --recent)');
