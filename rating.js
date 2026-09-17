/**
 * TrueRate scoring engine — v2.
 *
 * FinalScore (0-10) = 0.40 * NetLikeRate
 *                    + 0.20 * Reach
 *                    + 0.10 * VoteConfidence
 *                    + 0.10 * Engagement
 *                    + 0.20 * Maturity
 *
 * Design notes, since this differs meaningfully from v1:
 *
 * - NetLikeRate = (likes - dislikes) / views. The primary signal: what
 *   fraction of the WHOLE audience (not just those who voted) left a net
 *   positive reaction. This is what actually tells apart "a small number
 *   of people voted, mostly positively" from "a large fraction of viewers
 *   felt strongly enough to react" — neither VoteConfidence (ignores view
 *   count) nor Engagement (ignores whether votes were positive or
 *   negative) captures that on its own.
 *
 * - VoteConfidence is the Wilson 95% lower-confidence-bound on the like
 *   proportion (same idea as before), but now mapped onto a curve
 *   calibrated against realistic YouTube norms rather than a naive 50%
 *   midpoint. On YouTube, 90%+ like ratios are the norm for ordinary
 *   content — much of that driven by a channel's existing loyal fanbase
 *   voting reflexively — so treating 90% as "average" rather than
 *   "excellent" is a cheap, workable proxy for that bias without needing
 *   to fetch a channel's entire upload history to compute a true baseline.
 *
 * - Maturity is new: a video's numbers right after upload can be
 *   temporarily inflated by YouTube's own promotional push to a sample
 *   audience, or just not yet reflect its natural audience at all. This
 *   mirrors the same idea as Wilson's confidence handling for small vote
 *   counts, but for time instead. A very young video isn't penalized for
 *   being bad — it's discounted for being UNPROVEN, the same way a
 *   3-vote "100%" is discounted for being a small sample, not disbelieved
 *   outright. NOTE: this means a video that's already overwhelmingly
 *   excellent by every other signal will still score somewhat lower while
 *   young than it will once it's had time to prove that isn't a fluke —
 *   an intentional tradeoff, not an oversight.
 *
 * - Engagement gets a separate, more lenient curve for content detected
 *   as passively consumed / rewatched-without-re-voting (music uploads
 *   being the clearest case) — a song someone replays fifty times only
 *   ever contributes one vote, so raw engagement rate structurally
 *   under-counts how loved that content actually is.
 *
 * - Reach is EXCLUDED for Shorts unconditionally, not just when a
 *   subscriber count happens to be unavailable. Shorts get pushed to a
 *   much broader non-subscriber audience by design, so even a genuine
 *   subscriber count would make a normal Short look artificially viral
 *   against a scale calibrated for regular videos.
 *
 * - Any component whose input is unavailable (no subscriber count and not
 *   a Short exclusion, or no parseable upload date) has its weight
 *   redistributed proportionally across the remaining components, rather
 *   than being silently treated as a zero.
 */
(function (global) {
  const DEFAULT_WEIGHTS = {
    netLikeRate: 0.4,
    reach: 0.2,
    quality: 0.1,
    engagement: 0.1,
    time: 0.2,
  };

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

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

  function wilsonLowerBound(likes, dislikes, z) {
    z = z || 1.96;
    const n = likes + dislikes;
    if (n <= 0) return 0.5;
    const p = likes / n;
    const z2 = z * z;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    const denom = 1 + z2 / n;
    return clamp((centre - margin) / denom, 0, 1);
  }

  // ---- calibrated anchor curves ----
  // NetLikeRate: (likes - dislikes) / views, as a fraction.
  const NET_LIKE_RATE_ANCHORS = [
    [0, 1],
    [0.003, 4],
    [0.008, 5.5],
    [0.015, 6.5],
    [0.03, 7.5],
    [0.05, 8.5],
    [0.08, 9.5],
    [0.15, 10],
  ];

  // VoteConfidence: Wilson lower bound of the like proportion, 0-1.
  // Calibrated so ~90% (the realistic YouTube norm) lands near "average",
  // not "excellent".
  const QUALITY_ANCHORS = [
    [0.5, 0],
    [0.7, 2.5],
    [0.85, 4.5],
    [0.9, 5.5],
    [0.95, 7],
    [0.98, 8.5],
    [0.995, 9.5],
    [1.0, 10],
  ];

  // Engagement: (likes + dislikes + comments) / views, as a fraction.
  const ENGAGEMENT_ANCHORS = [
    [0, 1],
    [0.003, 3],
    [0.01, 5.5],
    [0.02, 7],
    [0.04, 8.5],
    [0.06, 9.5],
    [0.1, 10],
  ];

  // Same idea, much more lenient — for content where low engagement is
  // structurally expected rather than a sign of low quality.
  const ENGAGEMENT_ANCHORS_PASSIVE = [
    [0, 3],
    [0.001, 5],
    [0.003, 6.5],
    [0.006, 7.5],
    [0.012, 8.5],
    [0.02, 9.5],
    [0.035, 10],
  ];

  // Reach: views / subscribers.
  const REACH_ANCHORS = [
    [0, 0],
    [0.05, 3],
    [0.15, 5],
    [0.3, 6],
    [0.6, 7],
    [1.0, 8],
    [2.0, 9],
    [4.0, 10],
  ];

  // Maturity: days since publish. ~1 month to be considered "settled".
  const TIME_ANCHORS = [
    [0, 3],
    [3, 4.5],
    [7, 6],
    [14, 7],
    [30, 8.5],
    [60, 9.5],
    [120, 10],
  ];

  function netLikeRateScore(likes, dislikes, views) {
    if (!views || views <= 0) return null;
    return clamp(interpolate((likes - dislikes) / views, NET_LIKE_RATE_ANCHORS), 0, 10);
  }

  function qualityScore(likes, dislikes) {
    if (likes + dislikes <= 0) return null; // no votes at all: unknown, not "bad" — exclude and redistribute
    return clamp(interpolate(wilsonLowerBound(likes, dislikes), QUALITY_ANCHORS), 0, 10);
  }

  function engagementScore(likes, dislikes, comments, views, isMusic) {
    if (!views || views <= 0) return null;
    const rate = (likes + dislikes + (comments || 0)) / views;
    const anchors = isMusic ? ENGAGEMENT_ANCHORS_PASSIVE : ENGAGEMENT_ANCHORS;
    return clamp(interpolate(rate, anchors), 0, 10);
  }

  function reachScore(views, subscribers, isShort) {
    if (isShort) return null; // excluded unconditionally, see file header
    if (!subscribers || subscribers <= 0) return null;
    return clamp(interpolate(views / subscribers, REACH_ANCHORS), 0, 10);
  }

  function timeScore(daysSincePublish) {
    if (daysSincePublish == null || isNaN(daysSincePublish)) return null;
    return clamp(interpolate(Math.max(0, daysSincePublish), TIME_ANCHORS), 0, 10);
  }

  function confidenceLabel(totalVotes) {
    if (totalVotes < 100) return { label: "Low confidence", detail: "Very few votes — score may shift a lot as more come in." };
    if (totalVotes < 2000) return { label: "Moderate confidence", detail: "A modest number of votes." };
    return { label: "High confidence", detail: "A large, statistically stable sample of votes." };
  }

  /**
   * @param {Object} stats
   *   likes, dislikes, comments, views: numbers
   *   subscribers: number or null (hidden/unknown)
   *   isShort: boolean — excludes Reach unconditionally
   *   daysSincePublish: number or null — unknown skips Maturity, weight redistributed
   *   isMusic: boolean — uses the more lenient Engagement curve
   * @param {Object} [weights] {netLikeRate, reach, quality, engagement, time}
   */
  function computeRating(stats, weights) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const likes = Number(stats.likes) || 0;
    const dislikes = Number(stats.dislikes) || 0;
    const comments = Number(stats.comments) || 0;
    const views = Number(stats.views) || 0;
    const subscribers = stats.subscribers == null ? null : Number(stats.subscribers);
    const isShort = !!stats.isShort;
    const isMusic = !!stats.isMusic;
    const daysSincePublish = stats.daysSincePublish == null ? null : Number(stats.daysSincePublish);

    const netS = netLikeRateScore(likes, dislikes, views);
    const qualS = qualityScore(likes, dislikes);
    const engS = engagementScore(likes, dislikes, comments, views, isMusic);
    const reachS = reachScore(views, subscribers, isShort);
    const timeS = timeScore(daysSincePublish);

    // Build the set of available (component -> {score, weight}) pairs,
    // then normalize whatever weight remains across only what's available.
    const available = [
      { key: "netLikeRate", score: netS, weight: w.netLikeRate },
      { key: "reach", score: reachS, weight: w.reach },
      { key: "quality", score: qualS, weight: w.quality },
      { key: "engagement", score: engS, weight: w.engagement },
      { key: "time", score: timeS, weight: w.time },
    ].filter((c) => c.score != null);

    const weightSum = available.reduce((sum, c) => sum + c.weight, 0) || 1;
    const usedWeights = {};
    let finalScore = 0;
    available.forEach((c) => {
      const normalized = c.weight / weightSum;
      usedWeights[c.key] = normalized;
      finalScore += normalized * c.score;
    });
    ["netLikeRate", "reach", "quality", "engagement", "time"].forEach((k) => {
      if (!(k in usedWeights)) usedWeights[k] = 0;
    });

    finalScore = clamp(finalScore, 0, 10);

    return {
      finalScore: Math.round(finalScore * 100) / 100,
      netLikeRate: netS == null ? null : Math.round(netS * 100) / 100,
      reach: reachS == null ? null : Math.round(reachS * 100) / 100,
      quality: qualS == null ? null : Math.round(qualS * 100) / 100,
      engagement: engS == null ? null : Math.round(engS * 100) / 100,
      time: timeS == null ? null : Math.round(timeS * 100) / 100,
      likePercent: likes + dislikes > 0 ? Math.round((likes / (likes + dislikes)) * 10000) / 100 : null,
      engagementRatePercent: views > 0 ? Math.round(((likes + dislikes + comments) / views) * 10000) / 100 : null,
      netLikeRatePercent: views > 0 ? Math.round(((likes - dislikes) / views) * 10000) / 100 : null,
      reachRatioPercent: subscribers ? Math.round((views / subscribers) * 10000) / 100 : null,
      daysSincePublish: daysSincePublish,
      isShort: isShort,
      isMusic: isMusic,
      totalVotes: likes + dislikes,
      confidence: confidenceLabel(likes + dislikes),
      weightsUsed: usedWeights,
    };
  }

  global.TrueRateEngine = {
    DEFAULT_WEIGHTS,
    wilsonLowerBound,
    netLikeRateScore,
    qualityScore,
    engagementScore,
    reachScore,
    timeScore,
    computeRating,
  };
})(typeof window !== "undefined" ? window : globalThis);
