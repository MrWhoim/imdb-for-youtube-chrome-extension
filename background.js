/**
 * Background service worker (MV3).
 *
 * Fetches vote data from the Return YouTube Dislike API on behalf of the
 * watch-page content script AND the feed scanner (feed.js), which may ask
 * for dozens of video IDs while the user scrolls the home page or a Shorts
 * shelf. Centralizing this here — rather than fetching from each content
 * script directly — gives us one shared, rate-limited, cached path instead
 * of every open tab hammering the API independently.
 *
 * Attribution (required by returnyoutubedislike.com's API terms of use):
 * Vote data is provided by the Return YouTube Dislike open API,
 * https://returnyoutubedislike.com — an independent, crowdsourced project,
 * not affiliated with this extension or with YouTube/Google.
 */

const RYD_BASE = "https://returnyoutubedislikeapi.com";

// ---- cache ----
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const voteCache = new Map(); // videoId -> { data, ts }

function getCached(videoId) {
  const entry = voteCache.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    voteCache.delete(videoId);
    return null;
  }
  return entry.data;
}

function setCached(videoId, data) {
  voteCache.set(videoId, { data, ts: Date.now() });
  // Simple cap so long browsing sessions don't grow this unbounded.
  if (voteCache.size > 1500) {
    const oldestKey = voteCache.keys().next().value;
    voteCache.delete(oldestKey);
  }
}

// ---- rate-limited queue ----
// Return YouTube Dislike's published limits are 100 requests/minute and
// 10,000/day per client. We stay comfortably under the per-minute cap so a
// fast-scrolling feed never gets a 429.
const MAX_PER_MINUTE = 70;
let requestTimestamps = [];
const queue = [];
let draining = false;

function underRateLimit() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60000);
  return requestTimestamps.length < MAX_PER_MINUTE;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    if (!underRateLimit()) {
      await sleep(400);
      continue;
    }
    const job = queue.shift();
    const cached = getCached(job.videoId);
    if (cached) {
      job.resolve({ ok: true, data: cached });
      continue;
    }
    requestTimestamps.push(Date.now());
    try {
      const url = `${RYD_BASE}/votes?videoId=${encodeURIComponent(job.videoId)}`;
      const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Return YouTube Dislike API returned ${res.status}`);
      const data = await res.json();
      if (data && data.deleted) throw new Error("Video not found in Return YouTube Dislike's database.");
      setCached(job.videoId, data);
      job.resolve({ ok: true, data });
    } catch (err) {
      job.resolve({ ok: false, error: err.message || String(err) });
    }
  }
  draining = false;
}

function requestVotes(videoId) {
  return new Promise((resolve) => {
    const cached = getCached(videoId);
    if (cached) {
      resolve({ ok: true, data: cached });
      return;
    }
    queue.push({ videoId, resolve });
    drainQueue();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "FETCH_VOTES") return false;
  requestVotes(message.videoId).then(sendResponse);
  return true; // keep the message channel open for the async response
});
