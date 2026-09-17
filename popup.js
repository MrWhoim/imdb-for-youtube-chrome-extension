(function () {
  const els = {
    loading: document.getElementById("state-loading"),
    notYoutube: document.getElementById("state-not-youtube"),
    error: document.getElementById("state-error"),
    errorDetail: document.getElementById("error-detail"),
    retryBtn: document.getElementById("retry-btn"),
    report: document.getElementById("state-report"),

    finalScore: document.getElementById("final-score"),
    confidenceBadge: document.getElementById("confidence-badge"),
    videoTitle: document.getElementById("video-title"),
    channelLine: document.getElementById("channel-line"),

    barNetlike: document.getElementById("bar-netlike"),
    barQuality: document.getElementById("bar-quality"),
    barEngagement: document.getElementById("bar-engagement"),
    barReach: document.getElementById("bar-reach"),
    barTime: document.getElementById("bar-time"),
    valNetlike: document.getElementById("val-netlike"),
    valQuality: document.getElementById("val-quality"),
    valEngagement: document.getElementById("val-engagement"),
    valReach: document.getElementById("val-reach"),
    valTime: document.getElementById("val-time"),

    statLikes: document.getElementById("stat-likes"),
    statDislikes: document.getElementById("stat-dislikes"),
    statViews: document.getElementById("stat-views"),
    statComments: document.getElementById("stat-comments"),
    statNetlikepct: document.getElementById("stat-netlikepct"),
    statReachpct: document.getElementById("stat-reachpct"),
    statAge: document.getElementById("stat-age"),
    statType: document.getElementById("stat-type"),

    wNetlike: document.getElementById("w-netlike"),
    wQuality: document.getElementById("w-quality"),
    wEngagement: document.getElementById("w-engagement"),
    wReach: document.getElementById("w-reach"),
    wTime: document.getElementById("w-time"),
    wNetlikeVal: document.getElementById("w-netlike-val"),
    wQualityVal: document.getElementById("w-quality-val"),
    wEngagementVal: document.getElementById("w-engagement-val"),
    wReachVal: document.getElementById("w-reach-val"),
    wTimeVal: document.getElementById("w-time-val"),
    resetWeightsBtn: document.getElementById("reset-weights-btn"),

    reloadBtn: document.getElementById("reload-btn"),

    notYoutubeTitle: document.getElementById("not-youtube-title"),
    notYoutubeBody: document.getElementById("not-youtube-body"),
    feedToggle: document.getElementById("feed-toggle"),
  };

  const DEFAULT_WEIGHTS = window.TrueRateEngine.DEFAULT_WEIGHTS;
  let currentStats = null;
  let currentMeta = null;

  function showState(name) {
    ["loading", "notYoutube", "error", "report"].forEach((k) => {
      els[k].classList.toggle("hidden", k !== name);
    });
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return "–";
    return Number(n).toLocaleString();
  }

  function fmtPct(n) {
    if (n == null || isNaN(n)) return "–";
    return n.toFixed(2) + "%";
  }

  function weightsFromSliders() {
    const nl = Number(els.wNetlike.value);
    const r = Number(els.wReach.value);
    const q = Number(els.wQuality.value);
    const e = Number(els.wEngagement.value);
    const t = Number(els.wTime.value);
    const sum = nl + r + q + e + t || 1;
    return { netLikeRate: nl / sum, reach: r / sum, quality: q / sum, engagement: e / sum, time: t / sum };
  }

  function setSliderLabels() {
    els.wNetlikeVal.textContent = Math.round(Number(els.wNetlike.value)) + "%";
    els.wQualityVal.textContent = Math.round(Number(els.wQuality.value)) + "%";
    els.wEngagementVal.textContent = Math.round(Number(els.wEngagement.value)) + "%";
    els.wReachVal.textContent = Math.round(Number(els.wReach.value)) + "%";
    els.wTimeVal.textContent = Math.round(Number(els.wTime.value)) + "%";
  }

  function applyWeightsToSliders(weights) {
    els.wNetlike.value = Math.round(weights.netLikeRate * 100);
    els.wQuality.value = Math.round(weights.quality * 100);
    els.wEngagement.value = Math.round(weights.engagement * 100);
    els.wReach.value = Math.round(weights.reach * 100);
    els.wTime.value = Math.round(weights.time * 100);
    setSliderLabels();
  }

  function setBar(barEl, valEl, score, naLabel) {
    if (score == null) {
      barEl.style.width = "0%";
      valEl.textContent = naLabel || "n/a";
    } else {
      barEl.style.width = (score / 10) * 100 + "%";
      valEl.textContent = score.toFixed(1);
    }
  }

  function renderRating(rating) {
    els.finalScore.textContent = rating.finalScore.toFixed(2);
    els.confidenceBadge.textContent = rating.confidence.label;
    els.confidenceBadge.title = rating.confidence.detail;

    setBar(els.barNetlike, els.valNetlike, rating.netLikeRate);
    setBar(els.barQuality, els.valQuality, rating.quality);
    setBar(els.barEngagement, els.valEngagement, rating.engagement);
    setBar(els.barReach, els.valReach, rating.reach, rating.isShort ? "n/a (Short)" : "n/a");
    setBar(els.barTime, els.valTime, rating.time);

    els.statNetlikepct.textContent = rating.netLikeRatePercent == null ? "–" : rating.netLikeRatePercent.toFixed(2) + "%";
    els.statReachpct.textContent = rating.isShort
      ? "Excluded (Shorts)"
      : rating.reachRatioPercent == null
      ? "Hidden by channel"
      : fmtPct(rating.reachRatioPercent);
    els.statAge.textContent =
      rating.daysSincePublish == null
        ? "Unknown"
        : rating.daysSincePublish < 1
        ? "< 1 day ago"
        : Math.round(rating.daysSincePublish) + " days ago";
    els.statType.textContent = rating.isMusic ? "Music (adjusted)" : rating.isShort ? "Short" : "Standard";
  }

  function renderReport(report) {
    currentStats = report.stats;
    currentMeta = report;

    els.videoTitle.textContent = report.title || "(title unavailable)";
    els.channelLine.textContent = report.channelName
      ? report.channelName + (report.stats.subscribers ? " · " + fmt(report.stats.subscribers) + " subscribers" : "")
      : "";

    els.statLikes.textContent = fmt(report.stats.likes);
    els.statDislikes.textContent = fmt(report.stats.dislikes);
    els.statViews.textContent = fmt(report.stats.views);
    els.statComments.textContent = report.stats.comments ? fmt(report.stats.comments) : "–";

    renderRating(report.rating);
    showState("report");
  }

  function recomputeWithCurrentWeights() {
    if (!currentStats) return;
    const weights = weightsFromSliders();
    const rating = window.TrueRateEngine.computeRating(currentStats, weights);
    renderRating(rating);
    chrome.storage.sync.set({ trueRateWeights: weights });
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function isYouTubeWatchUrl(url) {
    if (!url) return false;
    return /^https:\/\/(www\.|m\.)?youtube\.com\/(watch\?|shorts\/)/.test(url) || /^https:\/\/youtu\.be\//.test(url);
  }

  function isYouTubeDomain(url) {
    if (!url) return false;
    return /^https:\/\/(www\.|m\.)?youtube\.com\//.test(url);
  }

  function setNotYoutubeMessage(tabUrl) {
    if (isYouTubeDomain(tabUrl)) {
      els.notYoutubeTitle.textContent = "No single video here";
      els.notYoutubeBody.textContent =
        "This page doesn't have one specific video to score. If thumbnail ratings are on, you'll see ⭐ badges appear on video cards as you scroll.";
    } else {
      els.notYoutubeTitle.textContent = "Not a YouTube video";
      els.notYoutubeBody.textContent = "Open a YouTube watch page to see its TrueRate score.";
    }
  }

  function requestReport(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "GET_REPORT" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: "NO_CONTENT_SCRIPT" });
          return;
        }
        resolve(response || { ok: false, error: "No response from page." });
      });
    });
  }

  async function injectContentScriptFallback(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["rating.js", "pagedata.js", "content.js", "feed.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
  }

  async function loadAndRender() {
    showState("loading");
    const tab = await getActiveTab();

    if (!tab || !isYouTubeWatchUrl(tab.url)) {
      setNotYoutubeMessage(tab && tab.url);
      showState("notYoutube");
      return;
    }

    let response = await requestReport(tab.id);

    if (!response.ok && response.error === "NO_CONTENT_SCRIPT") {
      try {
        await injectContentScriptFallback(tab.id);
        response = await requestReport(tab.id);
      } catch (e) {
        response = { ok: false, error: "Could not access this page. Try reloading it." };
      }
    }

    if (!response.ok) {
      els.errorDetail.textContent = response.error || "Something went wrong reading this video's data.";
      showState("error");
      return;
    }

    renderReport(response);
  }

  async function reloadAndAnalyze() {
    const tab = await getActiveTab();
    if (!tab) return;
    showState("loading");
    chrome.tabs.reload(tab.id);
    // Give the page time to fully load its embedded data before we re-scrape.
    setTimeout(loadAndRender, 2200);
  }

  // ---- wire up events ----
  els.retryBtn.addEventListener("click", loadAndRender);
  els.reloadBtn.addEventListener("click", reloadAndAnalyze);

  [els.wNetlike, els.wQuality, els.wEngagement, els.wReach, els.wTime].forEach((slider) => {
    slider.addEventListener("input", () => {
      setSliderLabels();
      recomputeWithCurrentWeights();
    });
  });

  els.resetWeightsBtn.addEventListener("click", () => {
    applyWeightsToSliders(DEFAULT_WEIGHTS);
    recomputeWithCurrentWeights();
  });

  els.feedToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ feedRatingEnabled: els.feedToggle.checked });
  });

  function isCompleteWeights(w) {
    return (
      w &&
      typeof w.netLikeRate === "number" &&
      typeof w.reach === "number" &&
      typeof w.quality === "number" &&
      typeof w.engagement === "number" &&
      typeof w.time === "number"
    );
  }

  // ---- init ----
  chrome.storage.sync.get(["trueRateWeights", "feedRatingEnabled"], (result) => {
    const savedWeights = isCompleteWeights(result.trueRateWeights) ? result.trueRateWeights : DEFAULT_WEIGHTS;
    applyWeightsToSliders(savedWeights);
    els.feedToggle.checked = result.feedRatingEnabled !== false; // default ON
    loadAndRender();
  });
})();
