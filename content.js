/**
 * Content script — runs on youtube.com watch pages.
 *
 * Responsibilities:
 *  1. Scrape public, on-page data (title, view count, subscriber count,
 *     comment count, published date) out of YouTube's embedded
 *     `ytInitialData` JSON blob. We search by KEY NAME rather than a fixed
 *     path, since key names tend to survive YouTube's frequent template
 *     reshuffles better than exact object paths.
 *  2. Ask the background worker for like/dislike data from the Return
 *     YouTube Dislike API.
 *  3. Compute the TrueRate score (via rating.js) and inject a small badge
 *     next to the like/dislike buttons.
 *  4. Answer requests from the popup for the same data, so the popup and
 *     the on-page badge always show the same numbers.
 *
 * LIMITATION (documented, not hidden): YouTube is a single-page app. If you
 * click from one video to another without a full reload, the embedded
 * ytInitialData blob on the page is not refreshed. The popup's "Reload &
 * analyze" button reloads the tab to guarantee fresh data.
 */

(function () {
  const BADGE_ID = "truerate-badge";

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.hostname.includes("youtu.be")) {
        return url.pathname.slice(1);
      }
      const v = url.searchParams.get("v");
      if (v) return v;
      const shortsMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Extract a balanced {...} JSON object starting at the first "{" at or
  // after `fromIndex`, respecting string literals so braces inside strings
  // don't confuse the depth counter.
  function extractBalancedJson(text, fromIndex) {
    const start = text.indexOf("{", fromIndex);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escapeNext) {
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  function getYtInitialData() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      const marker = "ytInitialData";
      const markerIdx = text.indexOf(marker);
      if (markerIdx === -1) continue;
      const eqIdx = text.indexOf("=", markerIdx);
      if (eqIdx === -1) continue;
      const jsonText = extractBalancedJson(text, eqIdx);
      if (!jsonText) continue;
      try {
        return JSON.parse(jsonText);
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  // Depth-first search for the first object that has `key` as a property.
  function findContainerByKey(obj, key, depth) {
    depth = depth || 0;
    if (depth > 40 || obj === null || typeof obj !== "object") return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findContainerByKey(item, key, depth + 1);
        if (found) return found;
      }
    } else {
      for (const k in obj) {
        const found = findContainerByKey(obj[k], key, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function parseCompactNumber(raw) {
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

  function scrapePageStats() {
    const data = getYtInitialData();
    const result = {
      title: null,
      channelName: null,
      views: null,
      subscribers: null,
      comments: null,
      publishedText: null,
    };
    if (!data) return result;

    const primary = findContainerByKey(data, "videoPrimaryInfoRenderer");
    if (primary) {
      const p = primary.videoPrimaryInfoRenderer;
      try {
        result.title = (p.title.runs || []).map((r) => r.text).join("");
      } catch (e) {}
      try {
        result.views = parseCompactNumber(
          p.viewCount.videoViewCountRenderer.viewCount.simpleText ||
            (p.viewCount.videoViewCountRenderer.viewCount.runs || []).map((r) => r.text).join("")
        );
      } catch (e) {}
      try {
        result.publishedText = p.dateText.simpleText;
      } catch (e) {}
    }

    const ownerContainer = findContainerByKey(data, "videoOwnerRenderer");
    if (ownerContainer) {
      const owner = ownerContainer.videoOwnerRenderer;
      try {
        result.channelName = (owner.title.runs || []).map((r) => r.text).join("");
      } catch (e) {}
      try {
        const subText =
          (owner.subscriberCountText && owner.subscriberCountText.simpleText) ||
          (owner.subscriberCountText &&
            (owner.subscriberCountText.runs || []).map((r) => r.text).join(""));
        result.subscribers = parseCompactNumber(subText);
      } catch (e) {}
    }

    const commentsHeader = findContainerByKey(data, "commentsEntryPointHeaderRenderer");
    if (commentsHeader) {
      const c = commentsHeader.commentsEntryPointHeaderRenderer;
      try {
        const txt =
          (c.commentCount && c.commentCount.simpleText) ||
          (c.commentCount && (c.commentCount.runs || []).map((r) => r.text).join(""));
        result.comments = parseCompactNumber(txt);
      } catch (e) {}
    }

    return result;
  }

  function fetchVotesFromBackground(videoId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "FETCH_VOTES", videoId }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from background worker." });
      });
    });
  }

  async function gatherFullReport() {
    const videoId = getVideoId();
    if (!videoId) return { ok: false, error: "Not a YouTube video page." };

    const pageStats = scrapePageStats();
    const votesRes = await fetchVotesFromBackground(videoId);

    if (!votesRes.ok) {
      return { ok: false, error: votesRes.error, pageStats, videoId };
    }

    const votes = votesRes.data;
    const stats = {
      likes: votes.likes,
      dislikes: votes.dislikes,
      comments: pageStats.comments || 0,
      views: pageStats.views || votes.viewCount || 0,
      subscribers: pageStats.subscribers,
    };

    const rating = window.TrueRateEngine.computeRating(stats);

    return {
      ok: true,
      videoId,
      title: pageStats.title,
      channelName: pageStats.channelName,
      publishedText: pageStats.publishedText,
      stats,
      rating,
    };
  }

  function injectBadge(report) {
    const existing = document.getElementById(BADGE_ID);
    if (existing) existing.remove();

    const anchor =
      document.querySelector("#top-level-buttons-computed") ||
      document.querySelector("ytd-menu-renderer#menu") ||
      document.querySelector("#title h1");
    if (!anchor) return;

    const badge = document.createElement("div");
    badge.id = BADGE_ID;

    if (!report.ok) {
      badge.className = "truerate-badge truerate-badge--error";
      badge.textContent = "TrueRate: unavailable";
      badge.title = report.error || "Could not compute a rating for this video.";
    } else {
      const r = report.rating;
      badge.className = "truerate-badge";
      badge.innerHTML =
        '<span class="truerate-star">\u2605</span> ' +
        '<span class="truerate-score">' + r.finalScore.toFixed(2) + '</span>' +
        '<span class="truerate-outof">/10</span>';
      badge.title =
        `TrueRate ${r.finalScore.toFixed(2)}/10 — Quality ${r.quality.toFixed(1)}, ` +
        `Engagement ${r.engagement.toFixed(1)}, Reach ${r.reach == null ? "n/a" : r.reach.toFixed(1)} ` +
        `(${r.confidence.label.toLowerCase()})`;
    }

    anchor.parentElement.insertBefore(badge, anchor);
  }

  let lastReport = null;

  async function run() {
    lastReport = await gatherFullReport();
    injectBadge(lastReport);
  }

  // Respond to popup requests.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "GET_REPORT") {
      // If we have not run yet on this load, run now.
      if (!lastReport) {
        run().then(() => sendResponse(lastReport));
        return true;
      }
      sendResponse(lastReport);
      return true;
    }
    return false;
  });

  // Initial run on load. YouTube's SPA navigation does not reload this
  // script, so we also listen for its client-side navigation event and
  // re-run best-effort (works when a fresh ytInitialData script tag is
  // present; otherwise the popup's "Reload & analyze" button guarantees
  // a correct result).
  run();
  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(run, 800);
  });
})();
