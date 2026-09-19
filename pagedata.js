/**
 * Shared utilities for reading YouTube's embedded page data, used by both
 * content.js (watch/Shorts player page) and feed.js (home feed, sidebar,
 * search results, Shorts shelves).
 *
 * Centralizing this means the watch page and the feed compute a video's
 * metadata (subscribers, views, comments) the exact same way, from the
 * exact same kind of source data — so the same video shouldn't score
 * differently just because of *where* it was scraped from.
 */
(function (global) {
  // ---- balanced-brace JSON extraction (see content.js history for why) ----
  function extractBalancedJson(text, fromIndex) {
    const start = text.indexOf("{", fromIndex);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escapeNext) escapeNext = false;
        else if (ch === "\\") escapeNext = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  // Finds and parses the page's main initial-data JSON blob, whichever of
  // YouTube's known variable names it's using on this page type.
  function getInitialData() {
    const markers = ["ytInitialData"];
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      for (const marker of markers) {
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

  // First object anywhere in the tree that has the given key.
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

  // First string leaf anywhere in the tree matching `regex`.
  function findFirstMatchingString(obj, regex, depth, maxDepth) {
    depth = depth || 0;
    maxDepth = maxDepth || 18;
    if (depth > maxDepth || obj === null || obj === undefined) return null;
    if (typeof obj === "string") return regex.test(obj) ? obj : null;
    if (typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = findFirstMatchingString(item, regex, depth + 1, maxDepth);
        if (r) return r;
      }
    } else {
      for (const k in obj) {
        const r = findFirstMatchingString(obj[k], regex, depth + 1, maxDepth);
        if (r) return r;
      }
    }
    return null;
  }

  // Builds a videoId -> data-node index in a single pass, so looking up
  // many videos (a whole feed's worth) doesn't mean re-walking the whole
  // JSON tree once per video.
  function buildVideoIndex(data) {
    const index = new Map();
    function walk(node, depth) {
      if (depth > 60 || node === null || typeof node !== "object") return;
      if (typeof node.videoId === "string" && !index.has(node.videoId)) {
        index.set(node.videoId, node);
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
      } else {
        for (const k in node) walk(node[k], depth + 1);
      }
    }
    walk(data, 0);
    return index;
  }

  function runsToText(field) {
    if (!field) return null;
    if (typeof field.simpleText === "string") return field.simpleText;
    if (Array.isArray(field.runs)) return field.runs.map((r) => r.text).join("");
    return null;
  }

  // Matches the shape of a published-date string regardless of which JSON
  // key it's stored under (relative spelled-out, relative abbreviated, or
  // absolute) — used as a fallback since exact key names for this field
  // have proven unstable across YouTube's redesigns.
  const PUBLISHED_DATE_PATTERN =
    /(\d+\s*(second|minute|hour|day|week|month|year)s?\s+ago)|(\d+\s*(mo|min|s|h|d|w|y)\s+ago)|([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/i;

  function findPublishedDateText(node) {
    if (!node) return null;
    try {
      const known = findContainerByKey(node, "publishedTimeText") || findContainerByKey(node, "dateText");
      if (known) {
        const t = runsToText(known.publishedTimeText || known.dateText);
        if (t) return t;
      }
    } catch (e) {}
    try {
      return findFirstMatchingString(node, PUBLISHED_DATE_PATTERN, 0, 25);
    } catch (e) {
      return null;
    }
  }

  // Pulls whatever we can find (title, channel, subscribers, views,
  // comments) out of a single video's JSON node — scoped to just that
  // node's own subtree, not the whole page, so pattern searches stay fast
  // and don't accidentally pick up a neighboring video's numbers.
  function extractMetaFromNode(node) {
    const result = {
      title: null,
      channelName: null,
      subscribers: null,
      views: null,
      comments: null,
      publishedText: null,
    };
    if (!node || typeof node !== "object") return result;

    try {
      result.title = runsToText(node.title);
    } catch (e) {}

    try {
      const ownerContainer =
        findContainerByKey(node, "ownerText") ||
        findContainerByKey(node, "shortBylineText") ||
        findContainerByKey(node, "longBylineText");
      if (ownerContainer) {
        result.channelName = runsToText(
          ownerContainer.ownerText || ownerContainer.shortBylineText || ownerContainer.longBylineText
        );
      }
    } catch (e) {}

    try {
      const subText = findFirstMatchingString(node, /subscribers?\b/i, 0, 18);
      if (subText) result.subscribers = parseCompactNumber(subText);
    } catch (e) {}

    try {
      const viewsContainer =
        findContainerByKey(node, "viewCountText") || findContainerByKey(node, "shortViewCountText");
      let viewsText = null;
      if (viewsContainer) {
        viewsText = runsToText(viewsContainer.viewCountText || viewsContainer.shortViewCountText);
      }
      if (!viewsText) viewsText = findFirstMatchingString(node, /\bviews?\b/i, 0, 18);
      if (viewsText) result.views = parseCompactNumber(viewsText);
    } catch (e) {}

    try {
      const commentsContainer = findContainerByKey(node, "commentCount");
      if (commentsContainer) {
        const t = runsToText(commentsContainer.commentCount);
        if (t) result.comments = parseCompactNumber(t);
      }
    } catch (e) {}

    result.publishedText = findPublishedDateText(node);

    return result;
  }

  // ---- shadow-DOM-aware query, used by the feed scanner ----
  function queryDeepAll(root, selector) {
    const out = [];
    function walk(node) {
      if (!node || !node.querySelectorAll) return;
      node.querySelectorAll(selector).forEach((el) => out.push(el));
      node.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    }
    walk(root);
    return out;
  }

  // Positive shape check: is this element actually video-thumbnail-shaped?
  // Landscape thumbnails (~4:3 to 16:9-ish) and portrait Shorts thumbnails
  // (~9:16-ish) both pass; small/near-square things (avatars, sidebar
  // icons, search-suggestion previews) do not, regardless of what YouTube
  // currently names their wrapping element.
  function isPlausibleThumbnailShape(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null; // not laid out yet
    const ratio = rect.width / rect.height;
    const landscape = ratio >= 1.15 && ratio <= 2.6 && rect.width >= 80 && rect.height >= 45;
    const portrait = ratio >= 0.35 && ratio <= 0.8 && rect.height >= 100 && rect.width >= 60;
    return landscape || portrait;
  }

  // For the WATCH PAGE's own current video: its info blocks
  // (videoPrimaryInfoRenderer, videoOwnerRenderer) generally aren't tagged
  // with a videoId at all — there's only one video on the page, so nothing
  // needs disambiguating. buildVideoIndex/extractMetaFromNode (designed for
  // feed lists, where every entry IS tagged with its own videoId) will
  // therefore usually fail to find them. This looks directly for the known
  // container keys instead, which only makes sense when there's exactly
  // one video on the page.
  function extractWatchPageMeta(data) {
    const result = {
      title: null,
      channelName: null,
      subscribers: null,
      views: null,
      comments: null,
      publishedText: null,
    };
    if (!data) return result;

    try {
      const primaryContainer = findContainerByKey(data, "videoPrimaryInfoRenderer");
      if (primaryContainer) {
        const p = primaryContainer.videoPrimaryInfoRenderer;
        result.title = runsToText(p.title);
        try {
          result.views = parseCompactNumber(
            runsToText(p.viewCount && p.viewCount.videoViewCountRenderer && p.viewCount.videoViewCountRenderer.viewCount)
          );
        } catch (e) {}
        result.publishedText = runsToText(p.dateText) || findPublishedDateText(p);
      }
    } catch (e) {}

    // Deliberately NOT falling back to a whole-page search here: without
    // videoPrimaryInfoRenderer to scope it, a date-shaped-string search
    // across the entire page has no way to distinguish the video's own
    // upload date from a comment's timestamp, a channel's join date, or
    // any other date-shaped text elsewhere on the page. Better to leave
    // Maturity excluded (and its weight redistributed) than to silently
    // show a confident but wrong number. The live-DOM fallback in
    // content.js, scoped to the metadata area specifically, is the
    // intended fallback for this case.

    try {
      const ownerContainer = findContainerByKey(data, "videoOwnerRenderer");
      if (ownerContainer) {
        const owner = ownerContainer.videoOwnerRenderer;
        result.channelName = runsToText(owner.title);
        let subText = runsToText(owner.subscriberCountText);
        if (!subText) subText = findFirstMatchingString(owner, /subscribers?\b/i, 0, 12);
        if (subText) result.subscribers = parseCompactNumber(subText);
      }
    } catch (e) {}

    try {
      const commentsHeader = findContainerByKey(data, "commentsEntryPointHeaderRenderer");
      if (commentsHeader) {
        const t = runsToText(commentsHeader.commentsEntryPointHeaderRenderer.commentCount);
        if (t) result.comments = parseCompactNumber(t);
      }
    } catch (e) {}

    return result;
  }

  // Converts YouTube's relative ("2 weeks ago", "Streamed 9 days ago",
  // and the ABBREVIATED forms YouTube uses in feed/sidebar contexts like
  // "4h ago", "1mo ago", "3d ago", "2w ago", "5y ago") or absolute
  // ("Nov 10, 2013") date text into an approximate number of days since
  // publish. Returns null if the text can't be parsed at all.
  function estimateDaysSincePublish(text) {
    if (!text) return null;
    const s = String(text).toLowerCase().trim();

    if (/\btoday\b/.test(s)) return 0.3;
    if (/\byesterday\b/.test(s)) return 1;

    // Spelled-out form: "4 hours ago", "2 weeks ago"
    let m = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (m) {
      const perDay = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.44, year: 365.25 };
      return parseInt(m[1], 10) * (perDay[m[2]] || 1);
    }

    // Abbreviated form: "4h ago", "1mo ago", "3d ago", "2w ago", "5y ago".
    // "mo" is checked before the single-letter units so "1mo" isn't
    // mis-parsed as "1m" + a stray "o".
    m = s.match(/(\d+)\s*(mo|min|s|h|d|w|y)\b\s*ago/);
    if (m) {
      const perDayAbbrev = { s: 1 / 86400, min: 1 / 1440, h: 1 / 24, d: 1, w: 7, mo: 30.44, y: 365.25 };
      return parseInt(m[1], 10) * (perDayAbbrev[m[2]] || 1);
    }

    const parsed = Date.parse(text);
    if (!isNaN(parsed)) {
      return Math.max(0, (Date.now() - parsed) / 86400000);
    }
    return null;
  }

  // Lightweight detector for "passively consumed, rewatched without
  // re-voting" content (official music uploads being the clearest case).
  // Catches official/label uploads well via their standard boilerplate;
  // will miss things like fan covers or ambient/lo-fi content that don't
  // carry the same auto-generated text — a known, documented limitation
  // rather than an attempt at a complete classifier.
  function isMusicLikeContent(scopeNode) {
    if (!scopeNode) return false;
    try {
      if (findFirstMatchingString(scopeNode, /provided to youtube by/i, 0, 30)) return true;
      if (findFirstMatchingString(scopeNode, /auto-generated by youtube/i, 0, 30)) return true;
      const richMeta = findContainerByKey(scopeNode, "richMetadataRenderer");
      if (richMeta) {
        const style = richMeta.richMetadataRenderer && richMeta.richMetadataRenderer.style;
        if (typeof style === "string" && /BOX_ART/i.test(style)) return true;
      }
    } catch (e) {}
    return false;
  }

  // Reads whatever is ACTUALLY rendered on screen, rather than assuming a
  // particular JSON shape. YouTube has been migrating parts of its watch
  // page to a new "content metadata view model" structure that the
  // classic videoPrimaryInfoRenderer/videoOwnerRenderer JSON parsing below
  // doesn't recognize at all — this is a fallback that works regardless of
  // which internal JSON schema is currently in use, since it just reads
  // text nodes.
  function findLiveDomText(selectors, regex) {
    for (const sel of selectors) {
      const root = document.querySelector(sel);
      if (!root) continue;
      try {
        // Matched against the whole concatenated text rather than testing
        // individual text nodes one at a time: if the target text is split
        // across adjacent nodes (common for interpolated strings), no
        // single node would ever match, silently letting the search fall
        // through to whatever unrelated date-shaped text comes next in the
        // container (a real bug this caused: an occasional wrong match
        // pulled from further down the page).
        const text = root.textContent || "";
        const match = text.match(regex);
        if (match) return match[0];
      } catch (e) {}
    }
    return null;
  }

  // Element.closest() does not cross shadow-DOM boundaries. This does, by
  // hopping to the shadow root's host element once it runs out of light-DOM
  // ancestors, so exclusion checks work correctly on anchors found via
  // queryDeepAll (which does pierce shadow roots).
  function closestAcrossShadow(el, selector) {
    let node = el;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      if (node.parentElement) {
        node = node.parentElement;
      } else if (node.getRootNode && typeof ShadowRoot !== "undefined" && node.getRootNode() instanceof ShadowRoot) {
        node = node.getRootNode().host;
      } else {
        break;
      }
    }
    return null;
  }

  // Finds a channel path (e.g. "/@channelname" or "/channel/UCxxxx") embedded
  // anywhere within a video's own JSON data — used to know which channel
  // page to fetch when subscriber count isn't available any other way.
  function findChannelUrlInNode(node) {
    if (!node) return null;
    try {
      const pathMatch = findFirstMatchingString(node, /^\/(@[\w.-]+|channel\/UC[\w-]{10,})$/i, 0, 25);
      if (pathMatch) return pathMatch;
      // YouTube frequently stores just the bare channel ID (no "/channel/"
      // prefix) in fields like navigationEndpoint.browseEndpoint.browseId —
      // the previous pattern-only check silently missed this entirely.
      const bareId = findFirstMatchingString(node, /^UC[\w-]{20,}$/, 0, 25);
      if (bareId) return "/channel/" + bareId;
    } catch (e) {}
    return null;
  }

  // Live-DOM fallback for the same thing, for when the JSON doesn't have
  // it either but a clickable channel link is actually rendered.
  function findChannelUrlLive(root) {
    const scope = root || document;
    try {
      const anchors = scope.querySelectorAll('a[href^="/@"], a[href^="/channel/"]');
      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (href) return href.split("?")[0];
      }
    } catch (e) {}
    return null;
  }

  global.TrueRatePageData = {
    getInitialData,
    parseCompactNumber,
    findContainerByKey,
    findFirstMatchingString,
    buildVideoIndex,
    extractMetaFromNode,
    extractWatchPageMeta,
    estimateDaysSincePublish,
    isMusicLikeContent,
    findLiveDomText,
    closestAcrossShadow,
    findChannelUrlInNode,
    findChannelUrlLive,
    runsToText,
    queryDeepAll,
    isPlausibleThumbnailShape,
  };
})(typeof window !== "undefined" ? window : globalThis);
