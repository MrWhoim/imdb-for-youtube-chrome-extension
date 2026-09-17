/**
 * Feed scanner — runs on every youtube.com page (home feed, search results,
 * sidebar recommendations, channel pages, Shorts shelves). Finds video
 * thumbnails and overlays a compact TrueRate badge on each one as it
 * scrolls into view.
 *
 * IMPORTANT DESIGN NOTE: this deliberately does NOT try to pick "the
 * right" anchor for a video at scan time (an earlier version compared
 * anchor sizes to prefer the larger one — the real thumbnail vs. a small
 * avatar bubble some Shorts cards also link with). That comparison is
 * unreliable: a lazy-loaded real thumbnail can still measure 0×0 at the
 * moment of comparison, while an already-loaded small avatar has a real,
 * nonzero size, so "biggest wins" can still pick the avatar.
 *
 * Instead: every candidate anchor is observed independently. Only once an
 * anchor is CONFIRMED visible (via IntersectionObserver, which guarantees
 * it has a real, settled size) does it get shape-checked. A global
 * "already badged" set, keyed by video ID, means whichever anchor for a
 * given video passes that check FIRST wins — an avatar bubble simply
 * fails its own shape check and is skipped, leaving the video unbadged
 * until its real thumbnail anchor is independently confirmed and checked.
 */

(function () {
  const PROCESSED_ATTR = "data-truerate-seen";
  const BADGE_CLASS = "truerate-chip";
  const SCAN_INTERVAL_MS = 1500;
  const PAGE_INDEX_REFRESH_MS = 4000;
  const PD = window.TrueRatePageData;

  let enabled = true;
  chrome.storage.sync.get(["feedRatingEnabled"], (result) => {
    enabled = result.feedRatingEnabled !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.feedRatingEnabled) {
      enabled = changes.feedRatingEnabled.newValue !== false;
      if (!enabled) removeAllBadges();
    }
  });

  function removeAllBadges() {
    document.querySelectorAll("." + BADGE_CLASS).forEach((el) => el.remove());
  }

  // Video IDs that already have a confirmed, successfully-shaped badge
  // somewhere on the page. First anchor to pass the shape check wins;
  // everything else for that video ID is a no-op from then on.
  const badgedVideoIds = new Set();

  let pageIndex = new Map();
  function refreshPageIndex() {
    try {
      const data = PD.getInitialData();
      pageIndex = data ? PD.buildVideoIndex(data) : new Map();
    } catch (e) {
      pageIndex = new Map();
    }
  }
  refreshPageIndex();
  setInterval(refreshPageIndex, PAGE_INDEX_REFRESH_MS);

  function extractVideoId(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (url.pathname.startsWith("/shorts/")) {
        const id = url.pathname.split("/")[2];
        return id ? { id, isShort: true } : null;
      }
      if (url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        if (v) return { id: v, isShort: false };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Broadened back to a generic href match in addition to id="thumbnail":
  // some current card layouts don't use that id at all, which was
  // silently excluding their thumbnails from ever being considered. This
  // is safe now (it wasn't a few rounds ago) because every candidate is
  // independently shape-checked and globally deduped by video ID below —
  // a title-text link matching this selector will simply fail the shape
  // check and be skipped, rather than stealing the badge from the real
  // thumbnail the way it used to.
  const CARD_SELECTORS = ["a#thumbnail", 'a[href^="/shorts/"]', 'a[href*="/watch?v="]'];

  // No size comparison, no picking a "winner" here — just find every
  // not-yet-seen candidate and hand each one to the observer individually.
  function findUnprocessedAnchors() {
    const found = [];
    const seenThisPass = new Set(); // avoid double-queuing one anchor that matches both selectors
    CARD_SELECTORS.forEach((sel) => {
      PD.queryDeepAll(document, sel).forEach((anchor) => {
        if (anchor.hasAttribute(PROCESSED_ATTR)) return;
        if (seenThisPass.has(anchor)) return;
        const info = extractVideoId(anchor.getAttribute("href"));
        if (!info) return;
        seenThisPass.add(anchor);
        anchor.setAttribute(PROCESSED_ATTR, "pending");
        found.push({ anchor, videoId: info.id, isShort: info.isShort });
      });
    });
    return found;
  }

  function fetchVotes(videoId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "FETCH_VOTES", videoId }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response." });
      });
    });
  }

  function makeBadge() {
    const badge = document.createElement("div");
    badge.className = BADGE_CLASS;
    badge.innerHTML = '<span class="truerate-chip-star">\u2605</span><span class="truerate-chip-val">\u2026</span>';
    return badge;
  }

  function renderBadgeScore(badge, rating) {
    badge.querySelector(".truerate-chip-val").textContent = rating.finalScore.toFixed(1);
    const reachLine = rating.reach == null
      ? (rating.isShort ? "Reach: excluded for Shorts" : "Reach: open the video for the full score (needs subscriber count)")
      : `Reach ${rating.reach.toFixed(1)}`;
    const timeLine = rating.time == null ? "Maturity: unknown upload date" : `Maturity ${rating.time.toFixed(1)}`;
    badge.title =
      `TrueRate ${rating.finalScore.toFixed(2)}/10\n` +
      `Net like rate ${rating.netLikeRate == null ? "n/a" : rating.netLikeRate.toFixed(1)} \u00b7 ` +
      `Vote confidence ${rating.quality == null ? "n/a" : rating.quality.toFixed(1)} \u00b7 ` +
      `Engagement ${rating.engagement == null ? "n/a" : rating.engagement.toFixed(1)}${rating.isMusic ? " (music-adjusted)" : ""}\n` +
      `${reachLine} \u00b7 ${timeLine}\n` +
      `${rating.confidence.label}`;
    badge.classList.add("truerate-chip--ready");
  }

  async function attachBadge(videoId, anchor, isShortHint) {
    anchor.setAttribute(PROCESSED_ATTR, "1");

    if (badgedVideoIds.has(videoId)) return; // a different anchor for this video already won

    // The ONLY shape check in the whole flow, run only once this specific
    // anchor is confirmed visible (so its size is real and settled).
    const shapeOk = PD.isPlausibleThumbnailShape(anchor.getBoundingClientRect());
    if (shapeOk === false) return;

    const computedPosition = getComputedStyle(anchor).position;
    if (computedPosition === "static") anchor.style.position = "relative";

    const badge = makeBadge();
    anchor.appendChild(badge);

    const res = await fetchVotes(videoId);
    if (!res.ok) {
      badge.remove();
      return;
    }

    if (badgedVideoIds.has(videoId)) {
      // Another anchor for this video won the race while this fetch was
      // in flight — don't leave a second badge behind.
      badge.remove();
      return;
    }

    const votes = res.data;
    const node = pageIndex.get(videoId);
    const meta = PD.extractMetaFromNode(node);

    const stats = {
      likes: votes.likes,
      dislikes: votes.dislikes,
      comments: meta.comments || 0,
      views: meta.views || votes.viewCount,
      subscribers: meta.subscribers,
      isShort: isShortHint,
      daysSincePublish: PD.estimateDaysSincePublish(meta.publishedText),
      isMusic: node ? PD.isMusicLikeContent(node) : false,
    };
    const rating = window.TrueRateEngine.computeRating(stats);
    renderBadgeScore(badge, rating);
    badgedVideoIds.add(videoId);
  }

  let observer = null;
  function getObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const anchor = entry.target;
          observer.unobserve(anchor);
          const info = extractVideoId(anchor.getAttribute("href"));
          if (info) attachBadge(info.id, anchor, info.isShort);
        });
      },
      { root: null, rootMargin: "200px", threshold: 0.1 }
    );
    return observer;
  }

  function scan() {
    if (!enabled) return;
    const anchors = findUnprocessedAnchors();
    if (anchors.length === 0) return;
    const obs = getObserver();
    anchors.forEach(({ anchor }) => obs.observe(anchor));
  }

  setInterval(scan, SCAN_INTERVAL_MS);
  scan();
  document.addEventListener("yt-navigate-finish", () => {
    badgedVideoIds.clear();
    setTimeout(scan, 800);
  });
})();
