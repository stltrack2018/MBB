import { pathToFileURL } from 'node:url';

export const AMS_ORIGIN = 'https://basketball-performance-hub.stltrack2018.chatgpt.site';
const SOURCES = new Set(['kinexon', 'firstbeat']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// This is ordinary HTTP and JavaScript. It has no AI client or model calls.
// The provider credentials remain on the existing AMS server.
export function createClient({ token = '', fetcher = fetch } = {}) {
  return async path => {
    const url = new URL(path, AMS_ORIGIN);
    requireValue(url.origin === AMS_ORIGIN && path.startsWith('/api/'), 'Unsupported AMS request');
    const response = await fetcher(url, {
      headers: { Accept: 'application/json', ...(token ? { 'OAI-Sites-Authorization': `Bearer ${token}` } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(55000),
    });
    requireValue(response.ok, `AMS HTTP ${response.status}`);
    requireValue((response.headers.get('content-type') ?? '').includes('application/json'), 'AMS did not return JSON');
    return response.json();
  };
}

export function verifySaved(source, status, data) {
  requireValue(SOURCES.has(source), 'Unsupported source');
  requireValue(status.configured === true && status.persisted === true, 'Source is not configured or saved data could not be verified');
  const completedAt = status.status?.completedAt;
  requireValue(timestamp(completedAt), 'No valid saved completion timestamp');
  let latestDate, counts;
  if (source === 'firstbeat') {
    requireValue(Array.isArray(data.measurements) && Array.isArray(data.laps), 'Missing saved Firstbeat records');
    requireValue(data.apiSync?.completedAt === completedAt, 'Firstbeat timestamp mismatch');
    requireValue(data.measurementCount === data.measurements.length && data.measurementCount === status.measurementCount, 'Firstbeat measurement count mismatch');
    requireValue(data.lapCount === data.laps.length && data.lapCount === status.lapCount, 'Firstbeat drill count mismatch');
    requireValue(data.apiSync?.matchedRoster === 15 && status.status?.matchedRoster === 15, 'Firstbeat roster mismatch');
    latestDate = data.apiSync?.latestTeamDate;
    requireValue(latestDate === status.status?.latestTeamDate, 'Firstbeat latest date mismatch');
    counts = { measurements: data.measurementCount, drillLaps: data.lapCount };
  } else {
    requireValue(Array.isArray(data.daily) && Array.isArray(data.loadDaily) && Array.isArray(data.players), 'Missing saved Kinexon records');
    requireValue(timestamp(data.generatedAt) && data.generatedAt === status.generatedAt && Date.parse(completedAt) >= Date.parse(data.generatedAt), 'Kinexon timestamp mismatch');
    requireValue(data.daily.length === status.counts?.dailyRows && data.loadDaily.length === status.counts?.totalDayRows, 'Kinexon daily count mismatch');
    requireValue(data.coverage?.phasePlayerRecords === status.counts?.drillRecords, 'Kinexon drill count mismatch');
    requireValue(data.players.every(p => Number.isInteger(p.phaseRecords) && p.phaseRecords >= 0), 'Invalid Kinexon phase counts');
    requireValue(data.players.reduce((total, p) => total + p.phaseRecords, 0) === status.counts?.drillRecords, 'Kinexon saved phase count mismatch');
    requireValue(data.roster?.matched === 15 && data.roster?.expected === 15 && data.roster?.unmatched?.length === 0, 'Kinexon roster mismatch');
    latestDate = data.coverage?.lastTeamDate;
    requireValue(latestDate === status.status?.latestTeamDate, 'Kinexon latest date mismatch');
    counts = { dailyRows: data.daily.length, totalDayRows: data.loadDaily.length, drillRecords: data.coverage.phasePlayerRecords };
  }
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(latestDate ?? ''), 'No valid latest saved date');
  return { source, latestDate, completedAt, counts, savedDataVerified: true };
}

export async function readVerified(source, request) {
  // A concurrent dashboard request may complete an import between the two reads.
  // Retry the read pair once rather than accepting different dataset revisions.
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await request(`/api/${source}?read=1&status=1`);
    const data = await request(`/api/${source}?read=1`);
    try {
      return {
        ...verifySaved(source, status, data),
        refreshComplete: status.complete === true && status.status?.state === 'succeeded' && status.refreshState !== 'refreshing',
        refreshState: status.refreshState,
      };
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

export async function refreshSource(source, {
  request = createClient(), wait = pause, now = Date.now,
  verifyOnly = false, maxSteps = 750, budgetMs = 270 * 60000,
} = {}) {
  requireValue(SOURCES.has(source), 'Choose kinexon or firstbeat');
  if (verifyOnly) return readVerified(source, request);
  const deadline = now() + budgetMs;
  let previousProgress, readFailures = 0;
  // Always attempt the normal due check; a saved success may belong to yesterday.
  // Never request force or provide fabricated authenticated-user headers.
  for (let step = 0; step < maxSteps && now() < deadline; step++) {
    let status;
    try {
      status = await request(`/api/${source}?${source === 'firstbeat' ? 'step=1&' : ''}status=1`);
      readFailures = 0;
    } catch {
      // A timeout cannot tell us whether the server saved progress. Read status
      // before resuming, using the existing server lease and saved checkpoint.
      if (++readFailures >= 3) throw new Error(`${source}: AMS could not be reached after three attempts`);
      await wait(5000);
      try { status = await request(`/api/${source}?read=1&status=1`); } catch { continue; }
    }
    requireValue(status.configured === true, `${source}: server configuration unavailable`);
    if (status.retryAt && timestamp(status.retryAt) && Date.parse(status.retryAt) > now()) {
      const retry = Date.parse(status.retryAt);
      requireValue(retry + 60000 < deadline, `${source}: provider cooldown exceeds this run; checkpoint retained`);
      // Remain inside this one daily run. Do not poll the provider in cooldown.
      while (now() < retry) await wait(Math.min(30000, retry - now()));
      continue;
    }
    if (status.refreshState === 'refreshing') {
      const progress = status.progress?.completedRequests;
      if (progress === previousProgress) await wait(5000);
      previousProgress = progress;
      continue;
    }
    requireValue(status.complete === true && status.persisted === true && status.status?.state === 'succeeded', `${source}: refresh incomplete (${status.refreshState ?? 'unknown'}); saved data retained`);
    const saved = await readVerified(source, request);
    // A new concurrent import after our completed refresh does not negate that
    // success. The saved data still has to be independently verified.
    requireValue(Date.parse(saved.completedAt) >= Date.parse(status.status.completedAt), `${source}: saved completion regressed`);
    return { ...saved, refreshComplete: true };
  }
  throw new Error(`${source}: refresh still in progress; checkpoint retained for next run`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const source = argv.find(arg => SOURCES.has(arg));
  requireValue(Boolean(source), 'Usage: node ams-updater.mjs kinexon|firstbeat [--verify-only]');
  const request = createClient({ token: process.env.AMS_SITE_TOKEN ?? '' });
  const result = await refreshSource(source, { request, verifyOnly: argv.includes('--verify-only') });
  // Aggregate-only logs. Do not print athlete data, raw provider errors or tokens.
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(() => {
    console.error('AMS updater did not complete. Saved history remains available. Review the source status in AMS.');
    process.exitCode = 1;
  });
}
