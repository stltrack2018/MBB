import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, verifySaved, readVerified, refreshSource, AMS_ORIGIN } from '../ams-updater.mjs';

const completedAt = '2026-11-06T14:00:00.000Z';
const firstbeatData = () => ({
  apiSync: { completedAt, matchedRoster: 15, latestTeamDate: '2026-11-05' },
  measurementCount: 1, lapCount: 1, measurements: [{}], laps: [{}],
});
const firstbeatStatus = () => ({
  configured: true, complete: true, persisted: true, refreshState: 'cached',
  measurementCount: 1, lapCount: 1,
  status: { state: 'succeeded', completedAt, matchedRoster: 15, latestTeamDate: '2026-11-05' },
});

test('rejects corrupt saved counts and mismatched revisions', () => {
  const status = firstbeatStatus(), data = firstbeatData();
  assert.equal(verifySaved('firstbeat', status, data).savedDataVerified, true);
  assert.throws(() => verifySaved('firstbeat', status, { ...data, measurements: [] }), /count mismatch/);
  assert.throws(() => verifySaved('firstbeat', status, { ...data, apiSync: { ...data.apiSync, completedAt: '2026-11-05T00:00:00Z' } }), /timestamp mismatch/);
});

test('an old success timestamp during a refreshing job is not completion', async () => {
  const pending = { ...firstbeatStatus(), complete: false, refreshState: 'refreshing', progress: { completedRequests: 12 } };
  let calls = 0;
  await assert.rejects(refreshSource('firstbeat', {
    request: async () => { calls++; return pending; }, wait: async () => {}, maxSteps: 2,
  }), /still in progress/);
  assert.equal(calls, 2);
});

test('read-only verification retains the distinction between history and completed refresh', async () => {
  const status = { ...firstbeatStatus(), complete: false, refreshState: 'backoff', status: { ...firstbeatStatus().status, state: 'failed' } };
  const paths = [];
  const result = await refreshSource('firstbeat', {
    verifyOnly: true,
    request: async path => { paths.push(path); return path.includes('status=1') ? status : firstbeatData(); },
  });
  assert.equal(result.savedDataVerified, true);
  assert.equal(result.refreshComplete, false);
  assert.ok(paths.every(path => path.includes('read=1')));
});

test('a provider cooldown fails visibly instead of accepting preserved history', async () => {
  await assert.rejects(refreshSource('firstbeat', {
    request: async () => ({ ...firstbeatStatus(), complete: false, refreshState: 'backoff', status: { ...firstbeatStatus().status, state: 'failed' } }),
  }), /refresh incomplete/);
});

test('a daily run respects the server retry time, then resumes without hourly jobs', async () => {
  let clock = Date.parse(completedAt), calls = 0;
  const retryAt = new Date(clock + 60000).toISOString();
  const result = await refreshSource('firstbeat', {
    now: () => clock, wait: async ms => { clock += ms; },
    request: async path => {
      if (!path.includes('read=1') && calls++ === 0) return { ...firstbeatStatus(), complete: false, refreshState: 'backoff', retryAt };
      return path.includes('status=1') ? firstbeatStatus() : firstbeatData();
    },
  });
  assert.equal(clock, Date.parse(retryAt));
  assert.equal(calls, 2);
  assert.equal(result.refreshComplete, true);
});

test('one daily run can resume across multiple hour-long provider cooldowns', async () => {
  let clock = Date.parse(completedAt), calls = 0;
  const result = await refreshSource('firstbeat', {
    now: () => clock, wait: async ms => { clock += ms; },
    request: async path => {
      if (!path.includes('read=1') && calls++ < 2) return { ...firstbeatStatus(), complete: false, refreshState: 'backoff', retryAt: new Date(clock + 61 * 60000).toISOString() };
      return path.includes('status=1') ? firstbeatStatus() : firstbeatData();
    },
  });
  assert.equal(clock, Date.parse(completedAt) + 122 * 60000);
  assert.equal(result.refreshComplete, true);
});

test('lost response resumes from server status without force or duplicate data writes', async () => {
  const paths = []; let mutationCalls = 0;
  const request = async path => {
    paths.push(path);
    if (path.includes('step=1') && mutationCalls++ === 0) throw new Error('lost response');
    return path.includes('status=1') ? firstbeatStatus() : firstbeatData();
  };
  const result = await refreshSource('firstbeat', { request, wait: async () => {} });
  assert.equal(result.refreshComplete, true);
  assert.equal(mutationCalls, 1);
  assert.ok(paths.every(path => !path.includes('force')));
  assert.equal(paths.at(-1), '/api/firstbeat?read=1');
});

test('concurrent completion during independent readback is checked again', async () => {
  let statusCalls = 0;
  const request = async path => {
    if (path.includes('status=1')) {
      const value = firstbeatStatus();
      if (statusCalls++ === 0) value.status.completedAt = '2026-11-05T00:00:00Z';
      return value;
    }
    return firstbeatData();
  };
  assert.equal((await readVerified('firstbeat', request)).savedDataVerified, true);
  assert.equal(statusCalls, 2);
});

test('Kinexon checks actual per-player phase counts', () => {
  const data = {
    generatedAt: completedAt, daily: [{}], loadDaily: [{}],
    players: [{ phaseRecords: 2 }],
    roster: { matched: 15, expected: 15, unmatched: [] },
    coverage: { phasePlayerRecords: 2, lastTeamDate: '2026-11-06' },
  };
  const status = {
    configured: true, persisted: true, generatedAt: completedAt,
    status: { completedAt, latestTeamDate: '2026-11-06' },
    counts: { dailyRows: 1, totalDayRows: 1, drillRecords: 2 },
  };
  assert.equal(verifySaved('kinexon', status, data).counts.drillRecords, 2);
  assert.throws(() => verifySaved('kinexon', status, { ...data, players: [{ phaseRecords: 1 }] }), /phase count mismatch/);
});

test('HTTP client pins the destination and never follows credential redirects', async () => {
  let call;
  const client = createClient({ token: 'test-token', fetcher: async (url, options) => {
    call = { url, options }; return Response.json({ ok: true });
  } });
  await client('/api/kinexon?read=1');
  assert.equal(call.url.origin, AMS_ORIGIN);
  assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.headers['OAI-Sites-Authorization'], 'Bearer test-token');
  await assert.rejects(client('//example.test/api/kinexon'), /Unsupported/);
  await assert.rejects(client('https://example.test/api/kinexon'), /Unsupported/);
});
