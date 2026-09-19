/**
 * Watch-page (and Shorts-player) content script.
 *
 * Responsibilities:
 *  1. Detect whether the current URL is actually a single-video page
 *     (/watch or /shorts/ID). If it isn't, do nothing at all.
 *  2. Pull that video's metadata using pagedata.js's watch-page-specific
 *     extractor (the current video's info blocks aren't videoId-tagged,
 *     unlike feed-list entries — see pagedata.js for why), with the
 *     videoId-indexed lookup as a fallback, and its like/dislike data from
 *     the background worker.
 *  3. Compute the TrueRate score and inject a badge, retrying not just on
 *     failure but until the BEST available placement is found — a
 *     lower-priority fallback anchor may be all that exists for a moment
 *     right after navigation, and this keeps trying to upgrade to the
 *     preferred spot rather than settling for whatever worked first.
 *  4. Answer the popup's requests for the same data.
 */

(function () {
  const BADGE_ID = "truerate-badge";
  const URL_POLL_MS = 700;
  const PD = window.TrueRatePageData;

  function getVideoInfo() {
    try {
      const url = new URL(location.href);
      if (url.hostname.includes("youtu.be")) {
        return { id: url.pathname.slice(1), isShort: false };
      }
      const shortsMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch) return { id: shortsMatch[1], isShort: true };
      if (url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        if (v) return { id: v, isShort: false };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

  function fetchChannelSubsFromBackground(channelUrl) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "FETCH_CHANNEL_SUBS", channelUrl }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from background worker." });
      });
    });
  }

  function mergeMeta(primary, fallback) {
    return {
      title: primary.title || fallback.title,
      channelName: primary.channelName || fallback.channelName,
      subscribers: primary.subscribers != null ? primary.subscribers : fallback.subscribers,
      views: primary.views != null ? primary.views : fallback.views,
      comments: primary.comments != null ? primary.comments : fallback.comments,
      publishedText: primary.publishedText || fallback.publishedText,
    };
  }

  async function gatherFullReport(videoId, isShort) {
    const data = PD.getInitialData();
    let meta = { title: null, channelName: null, subscribers: null, views: null, comments: null, publishedText: null };
    if (data) {
      meta = PD.extractWatchPageMeta(data);
      // Defensive fallback in case this page's data happens to be tagged
      // with videoId after all (structures do shift over time).
      if (meta.subscribers == null || meta.views == null) {
        const node = PD.buildVideoIndex(data).get(videoId);
        if (node) meta = mergeMeta(meta, PD.extractMetaFromNode(node));
      }
    }

    // Live-DOM fallback: YouTube has been migrating parts of the watch
    // page to newer structures (e.g. a "content metadata view model") that
    // the JSON parsing above doesn't recognize at all. Reading the
    // rendered text directly works regardless of which internal schema is
    // currently in use.
    if (!meta.publishedText) {
      const domDate = PD.findLiveDomText(
        ["ytd-watch-metadata", "#below", "#info", "#info-strings"],
        /(\d+\s*(second|minute|hour|day|week|month|year)s?\s+ago)|(\d+\s*(mo|min|s|h|d|w|y)\s+ago)|(streamed|premiered)|([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/i
      );
      if (domDate) meta = Object.assign({}, meta, { publishedText: domDate });
    }
    if (meta.subscribers == null) {
      const domSubText = PD.findLiveDomText(
        ["#owner", "ytd-video-owner-renderer", "ytd-watch-metadata"],
        /subscribers?\b/i
      );
      if (domSubText) meta = Object.assign({}, meta, { subscribers: PD.parseCompactNumber(domSubText) });
    }

    // Last resort: fetch the channel's own page in the background and read
    // its subscriber count from there. One request per page view here, so
    // the cost is small even though a full page fetch is heavier than the
    // votes lookup.
    if (meta.subscribers == null) {
      const channelUrl =
        (data && PD.findChannelUrlInNode(PD.buildVideoIndex(data).get(videoId))) || PD.findChannelUrlLive();
      if (channelUrl) {
        const subsRes = await fetchChannelSubsFromBackground(channelUrl);
        if (subsRes.ok) meta = Object.assign({}, meta, { subscribers: subsRes.subscribers });
      }
    }

    const votesRes = await fetchVotesFromBackground(videoId);
    if (!votesRes.ok) {
      return { ok: false, error: votesRes.error, meta, videoId };
    }

    const votes = votesRes.data;
    const stats = {
      likes: votes.likes,
      dislikes: votes.dislikes,
      comments: meta.comments || 0,
      views: meta.views || votes.viewCount || 0,
      subscribers: meta.subscribers,
      isShort: isShort,
      daysSincePublish: PD.estimateDaysSincePublish(meta.publishedText),
      isMusic: data ? PD.isMusicLikeContent(data) : false,
    };

    const rating = window.TrueRateEngine.computeRating(stats);

    return {
      ok: true,
      videoId,
      title: meta.title,
      channelName: meta.channelName,
      publishedText: meta.publishedText,
      stats,
      rating,
    };
  }

  // ---- badge construction ----
  function buildBadgeElement(report) {
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
      const parts = [
        `Net like rate ${r.netLikeRate == null ? "n/a" : r.netLikeRate.toFixed(1)}`,
        `Reach ${r.reach == null ? (r.isShort ? "n/a (Shorts excluded)" : "n/a") : r.reach.toFixed(1)}`,
        `Vote confidence ${r.quality == null ? "n/a" : r.quality.toFixed(1)}`,
        `Engagement ${r.engagement == null ? "n/a" : r.engagement.toFixed(1)}${r.isMusic ? " (music-adjusted)" : ""}`,
        `Maturity ${r.time == null ? "n/a" : r.time.toFixed(1)}`,
      ];
      const droppedNote = r.droppedComponent ? ` [${r.droppedComponent} dropped — top 4 of 5 used]` : "";
      badge.title = `TrueRate ${r.finalScore.toFixed(2)}/10 — ${parts.join(", ")} (${r.confidence.label.toLowerCase()})${droppedNote}`;
    }
    return badge;
  }

  // ---- normal watch-page placement ----
  // Tier 1 (preferred): next to the like/dislike buttons.
  // Tier 2/3: fallbacks used only until the preferred anchor exists.
  function findWatchAnchor() {
    const root = document.querySelector("ytd-watch-metadata") || document.querySelector("#below") || document;
    const preferred = root.querySelector("#top-level-buttons-computed");
    if (preferred) return { anchor: preferred, tier: 1 };
    const menu = root.querySelector("ytd-menu-renderer#menu");
    if (menu) return { anchor: menu, tier: 2 };
    const titleH1 = root.querySelector("#title h1");
    if (titleH1) return { anchor: titleH1, tier: 3 };
    return null;
  }

  function injectWatchBadge(report) {
    const found = findWatchAnchor();
    if (!found || !found.anchor.parentElement) return { inserted: false, tier: null };
    const badge = buildBadgeElement(report);
    found.anchor.parentElement.insertBefore(badge, found.anchor);
    return { inserted: true, tier: found.tier };
  }

  // ---- Shorts-player placement ----
  // The user wants the badge outside the video frame, above the channel
  // name — i.e., at the very top of the text/metadata panel below the
  // video, not inside any particular "row" within it. Walking a fixed
  // number of levels up from the Subscribe button to find a "row-sized"
  // container turned out to land inconsistently depending on each short's
  // actual DOM depth. Instead: walk up until the ancestor's own text
  // content is clearly more than just the button/channel name (i.e. it
  // also contains the title/description) — that's the outer panel — and
  // prepend the badge as its very first child.
  function findActiveShortsContainer() {
    return (
      document.querySelector("ytd-reel-video-renderer[is-active]") ||
      document.querySelector("ytd-shorts #shorts-player") ||
      document.querySelector("ytd-shorts") ||
      document.querySelector("#shorts-container")
    );
  }

  // Broadest reasonable root that should contain BOTH the active video and
  // its metadata panel (channel name, Subscribe, title) — even if those
  // turn out to be siblings rather than the panel being nested inside the
  // video renderer, which is what made the narrower
  // findActiveShortsContainer() miss the panel entirely on some Shorts.
  function findShortsSearchScope() {
    return document.querySelector("ytd-shorts") || document.querySelector("#shorts-container") || findActiveShortsContainer();
  }

  function isOnScreen(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  // Prefers a VISIBLE match — needed because the broader search scope can
  // contain preloaded adjacent Shorts (with their own, currently hidden,
  // Subscribe buttons) alongside the one actually on screen.
  function findSubscribeButtonWithin(root) {
    const candidates = PD.queryDeepAll(
      root,
      'button, yt-button-shape, tp-yt-paper-button, ytd-subscribe-button-renderer, [role="button"]'
    );
    let offscreenFallback = null;
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      if (text.indexOf("subscribe") !== -1 || aria.indexOf("subscribe") !== -1) {
        if (isOnScreen(el)) return el;
        if (!offscreenFallback) offscreenFallback = el;
      }
    }
    return offscreenFallback;
  }

  function findChannelLinkWithin(root) {
    const anchors = PD.queryDeepAll(root, 'a[href^="/@"], a[href^="/channel/"]');
    let onscreenSmall = null;
    let fallback = null;
    for (const a of anchors) {
      const rect = a.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.height < 60 && isOnScreen(a)) {
        onscreenSmall = a;
        break;
      }
      if (!fallback) fallback = a;
    }
    return onscreenSmall || fallback;
  }

  const META_PANEL_TEXT_THRESHOLD = 35; // "Subscribe" + a short channel name stays well under this

  function findShortsMetaPanel(startEl, boundary) {
    let el = startEl;
    for (let i = 0; i < 8 && el.parentElement && el.parentElement !== boundary; i++) {
      el = el.parentElement;
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || "").trim();
      if (rect.width > 100 && text.length > META_PANEL_TEXT_THRESHOLD) return el;
    }
    return el; // best effort
  }

  function injectShortsBadge(report) {
    const searchScope = findShortsSearchScope();
    if (!searchScope) return { inserted: false, tier: null };

    const badge = buildBadgeElement(report);
    const refEl = findSubscribeButtonWithin(searchScope) || findChannelLinkWithin(searchScope);

    if (refEl) {
      const panel = findShortsMetaPanel(refEl, searchScope);
      if (panel && panel.parentElement) {
        badge.classList.add("truerate-badge--shorts-inline");
        panel.insertBefore(badge, panel.firstChild);
        return { inserted: true, tier: 1 };
      }
    }

    // Fallback: couldn't confidently find the metadata panel at all.
    const container = findActiveShortsContainer();
    if (!container) return { inserted: false, tier: null };
    const computedPosition = getComputedStyle(container).position;
    if (computedPosition === "static") container.style.position = "relative";
    badge.classList.add("truerate-badge--overlay");
    container.appendChild(badge);
    return { inserted: true, tier: 2 };
  }

  function injectBadge(report, isShort) {
    const previous = document.getElementById(BADGE_ID);
    const result = isShort ? injectShortsBadge(report) : injectWatchBadge(report);
    // Only remove the old badge once the new one is confirmed placed, so a
    // failed attempt never leaves nothing behind.
    if (result.inserted && previous) previous.remove();
    return result;
  }

  function removeExistingBadge() {
    const existing = document.getElementById(BADGE_ID);
    if (existing) existing.remove();
  }

  let lastReport = null;
  let lastVideoId = null;
  let running = false;

  async function fetchReportWithRetry(videoId, isShort) {
    const delays = [0, 1000, 2000];
    let report = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await sleep(delays[i]);
      const stillCurrent = getVideoInfo();
      if (!stillCurrent || stillCurrent.id !== videoId) return null;
      report = await gatherFullReport(videoId, isShort);
      if (report.ok) return report;
    }
    return report;
  }

  // Keeps retrying placement not just on outright failure, but until the
  // BEST (tier 1) anchor is used — a fallback placement counts as
  // "showing something" but keeps trying to upgrade in the background.
  async function injectBadgeWithRetry(report, isShort, videoId) {
    const delays = [0, 500, 1000, 1500, 2500, 3500];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await sleep(delays[i]);
      const stillCurrent = getVideoInfo();
      if (!stillCurrent || stillCurrent.id !== videoId) return;
      const result = injectBadge(report, isShort);
      if (result.inserted && result.tier === 1) return; // best placement achieved
      // else: keep going, even if something was already placed at a
      // lower tier — the next attempt may find the preferred anchor.
    }
  }

  async function runForCurrentVideo() {
    const info = getVideoInfo();
    if (!info) {
      lastVideoId = null;
      lastReport = null;
      removeExistingBadge();
      return;
    }
    if (running) return;
    running = true;
    lastVideoId = info.id;

    const report = await fetchReportWithRetry(info.id, info.isShort);
    running = false;
    if (!report) return;

    lastReport = report;
    injectBadgeWithRetry(report, info.isShort, info.id);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "GET_REPORT") {
      const info = getVideoInfo();
      if (!info) {
        sendResponse({ ok: false, error: "Not a YouTube video page." });
        return true;
      }
      if (lastReport && lastVideoId === info.id) {
        sendResponse(lastReport);
        return true;
      }
      runForCurrentVideo().then(() => sendResponse(lastReport));
      return true;
    }
    return false;
  });

  let lastSeenVideoId = (getVideoInfo() || {}).id || null;
  function checkForNavigation() {
    const info = getVideoInfo();
    const currentId = info ? info.id : null;
    if (currentId !== lastSeenVideoId) {
      lastSeenVideoId = currentId;
      runForCurrentVideo();
    }
  }
  setInterval(checkForNavigation, URL_POLL_MS);

  runForCurrentVideo();
})();
