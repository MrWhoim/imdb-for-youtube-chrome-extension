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

// ---- channel subscriber-count fallback ----
// Used only when a video's own page/feed data doesn't include subscriber
// count at all (common for sidebar recommendations and search results,
// which carry less metadata than the home feed). Fetches the channel's own
// YouTube page — not a third-party service — and reads the same kind of
// subscriber text a person would see on that page.
const CHANNEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // subscriber counts change slowly
const channelSubsCache = new Map(); // channelUrl -> { subscribers, ts }
const MAX_CHANNEL_FETCHES_PER_MINUTE = 15; // a full page fetch is much heavier than a votes lookup
let channelFetchTimestamps = [];
let totalChannelFetchesThisSession = 0;
const MAX_CHANNEL_FETCHES_PER_SESSION = 80; // simple ceiling against runaway background activity

function parseCompactNumberLocal(raw) {
  if (raw == null) return null;
  const str = String(raw).replace(/,/g, "").trim();
  const m = str.match(/^([\d.]+)\s*([KMB]?)/i);
  if (!m) {
    const n = parseFloat(str);
    return isNaN(n) ? null : Math.round(n);
  }
  let num = parseFloat(m[1]);
  const suffix = m[2].toUpperCase();
  if (suffix === "K") num *= 1e3;
  else if (suffix === "M") num *= 1e6;
  else if (suffix === "B") num *= 1e9;
  return Math.round(num);
}

// Also handles the spelled-out form YouTube uses in aria-labels, e.g.
// "7.24 million subscribers" rather than "7.24M subscribers".
function parseSubscriberPhrase(raw) {
  if (raw == null) return null;
  const str = String(raw).toLowerCase();
  const wordMatch = str.match(/^([\d.,]+)\s*(thousand|million|billion)\b/i);
  if (wordMatch) {
    let num = parseFloat(wordMatch[1].replace(/,/g, ""));
    if (!isNaN(num)) {
      if (wordMatch[2] === "thousand") num *= 1e3;
      else if (wordMatch[2] === "million") num *= 1e6;
      else if (wordMatch[2] === "billion") num *= 1e9;
      return Math.round(num);
    }
  }
  return parseCompactNumberLocal(raw);
}

function underChannelRateLimit() {
  const now = Date.now();
  channelFetchTimestamps = channelFetchTimestamps.filter((t) => now - t < 60000);
  return channelFetchTimestamps.length < MAX_CHANNEL_FETCHES_PER_MINUTE;
}

async function fetchChannelSubscribers(channelUrl) {
  const cached = channelSubsCache.get(channelUrl);
  if (cached && Date.now() - cached.ts < CHANNEL_CACHE_TTL_MS) {
    return cached.subscribers;
  }
  if (totalChannelFetchesThisSession >= MAX_CHANNEL_FETCHES_PER_SESSION) {
    throw new Error("Channel-lookup budget for this session reached.");
  }
  while (!underChannelRateLimit()) {
    await sleep(500);
  }
  channelFetchTimestamps.push(Date.now());
  totalChannelFetchesThisSession++;

  const fullUrl = channelUrl.startsWith("http") ? channelUrl : `https://www.youtube.com${channelUrl}`;
  const res = await fetch(fullUrl, { credentials: "omit" });
  if (!res.ok) throw new Error(`Channel page returned ${res.status}`);
  const html = await res.text();

  let match = html.match(/"subscriberCountText":\s*\{\s*"simpleText":\s*"([^"]*subscribers?)"\s*\}/i);
  if (!match) match = html.match(/aria-label="(\d[\d.,]*\s*(thousand|million|billion)?\s*subscribers?)"/i);
  if (!match) match = html.match(/([\d][\d.,]*\s*[KMB]?\s*subscribers?)/i);
  if (!match) {
    console.warn("[TrueRate] Could not find a subscriber count on channel page:", fullUrl);
    throw new Error("Could not find a subscriber count on the channel page.");
  }

  const subscribers = parseSubscriberPhrase(match[1]);
  channelSubsCache.set(channelUrl, { subscribers, ts: Date.now() });
  return subscribers;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "FETCH_CHANNEL_SUBS") return false;
  fetchChannelSubscribers(message.channelUrl)
    .then((subscribers) => sendResponse({ ok: true, subscribers }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
