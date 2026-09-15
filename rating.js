/**
 * TrueRate scoring engine.
 *
 * Loaded as a plain script (no ES modules) so it can be shared, unmodified,
 * between the content script (isolated world on youtube.com) and the popup
 * page. Both contexts get a global `TrueRateEngine` object.
 *
 * ---------------------------------------------------------------------------
 * THE ALGORITHM
 * ---------------------------------------------------------------------------
 * FinalScore (0-10) = wQ * QualityScore
 *                    + wE * EngagementScore
 *                    + wR * ReachScore
 *
 * 1. QualityScore  — Wilson lower-bound (95% CI) of the like proportion.
 *    Corrects the naive like% for sample size, the same idea IMDb uses to
 *    stop a 3-vote "10/10" outranking a 300,000-vote "8.9/10". A video with
 *    few votes is pulled toward a conservative estimate; a video with many
 *    votes converges to its raw ratio.
 *
 * 2. EngagementScore — (likes + dislikes + comments) / views, mapped onto a
 *    0-10 curve against rough real-world benchmarks. Measures what fraction
 *    of viewers actually reacted. Purchased/bot views rarely like, dislike,
 *    or comment, so this is the main defense against inflated view counts.
 *
 * 3. ReachScore — views / subscribers, log-scaled to 0-10. Normalizes
 *    popularity against the channel's own size, so an 11M-view video from a
 *    500K-subscriber channel (viral, 22x reach) doesn't get confused with an
 *    11M-view video from a 33M-subscriber channel (33% reach, solid but
 *    expected for the channel's size).
 *
 * Views-per-day since publish is surfaced as an informational stat but is
 * deliberately NOT scored — a defensible time-decay curve would need
 * category-specific baselines (a news clip and an evergreen tutorial age
 * completely differently) this extension has no way to know, so folding it
 * into the score would be false precision rather than fairness.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  const DEFAULT_WEIGHTS = { quality: 0.5, engagement: 0.3, reach: 0.2 };

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  // Piecewise-linear interpolation over a sorted list of [x, y] anchors.
  function interpolate(x, anchors) {
    if (x <= anchors[0][0]) return anchors[0][1];
    const last = anchors[anchors.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 0; i < anchors.length - 1; i++) {
      const [x0, y0] = anchors[i];
      const [x1, y1] = anchors[i + 1];
      if (x >= x0 && x <= x1) {
        const t = (x - x0) / (x1 - x0);
        return y0 + t * (y1 - y0);
      }
    }
    return last[1];
  }

  /** Wilson score lower bound, 95% confidence, returned in [0, 1]. */
  function wilsonLowerBound(likes, dislikes, z) {
    z = z || 1.96;
    const n = likes + dislikes;
    if (n <= 0) return 0.5; // no data at all: neutral prior
    const p = likes / n;
    const z2 = z * z;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    const denom = 1 + z2 / n;
    return clamp((centre - margin) / denom, 0, 1);
  }

  function qualityScore(likes, dislikes) {
    return wilsonLowerBound(likes, dislikes) * 10;
  }

  // rate is a fraction, e.g. 0.02 = 2% engagement.
  const ENGAGEMENT_ANCHORS = [
    [0, 0],
    [0.002, 2],
    [0.005, 4],
    [0.01, 5],
    [0.02, 6.5],
    [0.04, 8],
    [0.06, 9.3],
    [0.10, 10],
  ];
  function engagementScore(likes, dislikes, comments, views) {
    if (!views || views <= 0) return 0;
    const rate = (likes + dislikes + (comments || 0)) / views;
    return clamp(interpolate(rate, ENGAGEMENT_ANCHORS), 0, 10);
  }

  // ratio = views / subscribers.
  const REACH_ANCHORS = [
    [0, 0],
    [0.01, 1],
    [0.05, 3],
    [0.1, 4.5],
    [0.25, 6],
    [0.5, 7.5],
    [1.0, 9],
    [2.0, 10],
  ];
  function reachScore(views, subscribers) {
    if (!subscribers || subscribers <= 0) return null; // unknown / hidden subs
    const ratio = views / subscribers;
    return clamp(interpolate(ratio, REACH_ANCHORS), 0, 10);
  }

  function confidenceLabel(totalVotes) {
    if (totalVotes < 100) return { label: "Low confidence", detail: "Very few votes — score may shift a lot as more come in." };
    if (totalVotes < 2000) return { label: "Moderate confidence", detail: "A modest number of votes." };
    return { label: "High confidence", detail: "A large, statistically stable sample of votes." };
  }

  /**
   * @param {Object} stats
   *   likes, dislikes, comments, views, subscribers: numbers (subscribers may be null if hidden)
   * @param {Object} [weights] {quality, engagement, reach} summing to 1 (not enforced, but recommended)
   */
  function computeRating(stats, weights) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const likes = Number(stats.likes) || 0;
    const dislikes = Number(stats.dislikes) || 0;
    const comments = Number(stats.comments) || 0;
    const views = Number(stats.views) || 0;
    const subscribers = stats.subscribers == null ? null : Number(stats.subscribers);

    const q = qualityScore(likes, dislikes);
    const e = engagementScore(likes, dislikes, comments, views);
    const r = reachScore(views, subscribers);

    // If reach is unavailable (hidden subscriber count), redistribute its
    // weight proportionally across quality and engagement rather than
    // silently treating it as a 0 (which would unfairly tank the score).
    let finalScore;
    let usedWeights;
    if (r === null) {
      const scale = 1 / (w.quality + w.engagement || 1);
      usedWeights = { quality: w.quality * scale, engagement: w.engagement * scale, reach: 0 };
      finalScore = usedWeights.quality * q + usedWeights.engagement * e;
    } else {
      const sum = w.quality + w.engagement + w.reach || 1;
      usedWeights = { quality: w.quality / sum, engagement: w.engagement / sum, reach: w.reach / sum };
      finalScore = usedWeights.quality * q + usedWeights.engagement * e + usedWeights.reach * r;
    }

    finalScore = clamp(finalScore, 0, 10);

    return {
      finalScore: Math.round(finalScore * 100) / 100,
      quality: Math.round(q * 100) / 100,
      engagement: Math.round(e * 100) / 100,
      reach: r === null ? null : Math.round(r * 100) / 100,
      likePercent: likes + dislikes > 0 ? Math.round((likes / (likes + dislikes)) * 10000) / 100 : null,
      engagementRatePercent: views > 0 ? Math.round(((likes + dislikes + comments) / views) * 10000) / 100 : null,
      reachRatioPercent: subscribers ? Math.round((views / subscribers) * 10000) / 100 : null,
      totalVotes: likes + dislikes,
      confidence: confidenceLabel(likes + dislikes),
      weightsUsed: usedWeights,
    };
  }

  global.TrueRateEngine = {
    DEFAULT_WEIGHTS,
    wilsonLowerBound,
    qualityScore,
    engagementScore,
    reachScore,
    computeRating,
  };
})(typeof window !== "undefined" ? window : globalThis);
