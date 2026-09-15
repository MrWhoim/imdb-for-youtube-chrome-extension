/**
 * Feed scanner — runs on every youtube.com page (home feed, search results,
 * sidebar recommendations, channel pages, Shorts shelves). Finds video
 * thumbnails, and overlays a compact TrueRate badge on each one as it
 * scrolls into view, so you get a rating before clicking in.
 *
 * WHY THIS IS LIGHTER THAN THE WATCH-PAGE SCORE
 * Feed thumbnails only carry a videoId — not the channel's subscriber count
 * (that's only sent to you once you actually open a video). So feed badges
 * show Quality + Engagement only; Reach ("n/a" here) is only ever computed
 * on the watch page, where the real number is available. This is stated
 * in the badge's tooltip rather than hidden.
 *
 * HOW CARDS ARE FOUND
 * YouTube renames its custom elements across redesigns fairly often, so
 * instead of matching e.g. <ytd-rich-item-renderer>, this looks for anchor
 * tags whose href points at a watch page or a short — that pattern has
 * stayed stable far longer than any specific element name. Because many of
 * YouTube's components render inside *open* shadow roots, the search
 * recurses into shadow DOM as well as the light DOM.
 *
 * HOW NEW CARDS ARE PICKED UP
 * YouTube's feed is a SPA with infinite scroll, so cards keep appearing
 * after the initial load. A short polling interval re-scans for new,
 * not-yet-processed anchors. This is simpler and more reliable across
 * YouTube's shadow-DOM-heavy markup than trying to attach MutationObservers
 * to every shadow root individually.
 */

(function () {
  const PROCESSED_ATTR = "data-truerate-seen";
  const BADGE_CLASS = "truerate-chip";
  const SCAN_INTERVAL_MS = 1500;

  let enabled = true; // toggled from the popup via chrome.storage

  chrome.storage.sync.get(["feedRatingEnabled"], (result) => {
    enabled = result.feedRatingEnabled !== false; // default ON
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

  // ---- shadow-DOM-aware query ----
  function queryDeepAll(root, selector) {
    const out = [];
    function walk(node) {
      if (!node) return;
      if (node.querySelectorAll) {
        node.querySelectorAll(selector).forEach((el) => out.push(el));
        node.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      }
    }
    walk(root);
    return out;
  }

  function extractVideoId(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (url.pathname.startsWith("/shorts/")) {
        const id = url.pathname.split("/")[2];
        return id ? { id, isShort: true } : null;
      }
      const v = url.searchParams.get("v");
      if (v) return { id: v, isShort: false };
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  const CARD_SELECTORS = ['a#thumbnail', 'a[href^="/shorts/"]', 'a[href*="/watch?v="]'];

  // Selectors for known "this is an avatar, not a thumbnail" wrappers.
  // YouTube reuses id="thumbnail" on the small circular channel-avatar link
  // too, so selector matching alone isn't enough to tell them apart.
  const AVATAR_WRAPPER_SELECTOR =
    "ytd-channel-thumbnail, yt-decorated-avatar-view-model, yt-avatar-shape, " +
    "#avatar, #avatar-link, #channel-thumbnail, ytd-video-owner-renderer, " +
    "ytd-author-comment-badge-renderer";

  // Real video thumbnails are always noticeably wider than they are a tiny
  // circle — channel avatars in feeds are small squares/circles (roughly
  // 24-48px). Anything narrower than this is almost certainly an avatar,
  // regardless of what YouTube currently names the wrapping element.
  const MIN_THUMBNAIL_WIDTH = 80;

  function looksLikeAvatar(anchor) {
    if (anchor.closest(AVATAR_WRAPPER_SELECTOR)) return true;
    const rect = anchor.getBoundingClientRect();
    if (rect.width > 0 && rect.width < MIN_THUMBNAIL_WIDTH) return true;
    return false;
  }

  function findUnprocessedCards() {
    const seen = new Map(); // videoId -> anchor
    CARD_SELECTORS.forEach((sel) => {
      queryDeepAll(document, sel).forEach((anchor) => {
        if (anchor.hasAttribute(PROCESSED_ATTR)) return;
        if (looksLikeAvatar(anchor)) return;
        const info = extractVideoId(anchor.getAttribute("href"));
        if (!info) return;
        if (!seen.has(info.id)) seen.set(info.id, { anchor, isShort: info.isShort });
      });
    });
    return seen;
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
    badge.title =
      `TrueRate ${rating.finalScore.toFixed(2)}/10 (feed estimate)\n` +
      `Quality ${rating.quality.toFixed(1)} · Engagement ${rating.engagement.toFixed(1)}\n` +
      `Reach: open the video for the full score (needs subscriber count)\n` +
      `${rating.confidence.label}`;
    badge.classList.add("truerate-chip--ready");
  }

  async function attachBadge(videoId, anchor) {
    anchor.setAttribute(PROCESSED_ATTR, "1");

    if (looksLikeAvatar(anchor)) return; // re-check: layout may have settled since the scan

    // Ensure the anchor can host an absolutely-positioned child.
    const computedPosition = getComputedStyle(anchor).position;
    if (computedPosition === "static") {
      anchor.style.position = "relative";
    }

    const badge = makeBadge();
    anchor.appendChild(badge);

    const res = await fetchVotes(videoId);
    if (!res.ok) {
      badge.remove(); // don't clutter the feed with "unavailable" chips
      return;
    }

    const votes = res.data;
    const stats = {
      likes: votes.likes,
      dislikes: votes.dislikes,
      comments: 0, // not available without opening the video
      views: votes.viewCount,
      subscribers: null, // not available without opening the video
    };
    const rating = window.TrueRateEngine.computeRating(stats);
    renderBadgeScore(badge, rating);
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
          if (info) attachBadge(info.id, anchor);
        });
      },
      { root: null, rootMargin: "200px", threshold: 0.1 }
    );
    return observer;
  }

  function scan() {
    if (!enabled) return;
    const cards = findUnprocessedCards();
    if (cards.size === 0) return;
    const obs = getObserver();
    cards.forEach(({ anchor }) => {
      anchor.setAttribute(PROCESSED_ATTR, "pending");
      obs.observe(anchor);
    });
  }

  // findUnprocessedCards marks nothing itself, so mark "pending" immediately
  // above to avoid re-queuing the same anchor on the next scan tick while we
  // wait for it to scroll into view.
  // (attachBadge overwrites the attribute to "1" once actually processed.)

  setInterval(scan, SCAN_INTERVAL_MS);
  scan();
  document.addEventListener("yt-navigate-finish", () => setTimeout(scan, 800));
})();
