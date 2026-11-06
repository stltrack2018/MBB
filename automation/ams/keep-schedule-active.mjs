// Preserve the public-repository schedule beyond GitHub's inactivity cutoff.
// This records only a timestamp, at most once every 28 days.
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GitHub runtime unavailable');
const url = `https://api.github.com/repos/${repo}/contents/.github/ams-schedule-heartbeat`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const response = await fetch(url, { headers, redirect: 'error' });
let sha, previous;
if (response.ok) {
  const file = await response.json();
  sha = file.sha;
  previous = Date.parse(Buffer.from(file.content, 'base64').toString('utf8').trim());
} else if (response.status !== 404) throw new Error(`GitHub schedule maintenance HTTP ${response.status}`);
if (Number.isFinite(previous) && Date.now() - previous < 28 * 86400000) process.exit(0);
const updated = await fetch(url, {
  method: 'PUT', headers, redirect: 'error',
  body: JSON.stringify({ message: 'Maintain daily AMS schedule', content: Buffer.from(new Date().toISOString() + '\n').toString('base64'), ...(sha ? { sha } : {}) }),
});
if (!updated.ok) throw new Error(`GitHub schedule maintenance HTTP ${updated.status}`);
console.log('Daily schedule activity preserved.');
