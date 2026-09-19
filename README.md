# TrueRate for YouTube

A Chrome extension that gives every YouTube video a fairer, IMDb-style
`⭐ X.XX / 10` rating — instead of a naive like-percentage, it factors in
**statistical confidence, real viewer engagement, and popularity relative to
the channel's own subscriber base.**

## Install (unpacked / developer mode)

1. Unzip this folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `yt-video-rating` folder.
5. Open any YouTube video. A small badge appears near the like/dislike
   buttons, and clicking the extension icon opens the full breakdown.

## Ratings on the Home page and Shorts feed

As you scroll YouTube's home page, sidebar, search results, or a Shorts
shelf, a small ⭐ chip appears in the top-left corner of each thumbnail —
computed as it scrolls into view, so ratings never load for cards you never
see. This can be turned off from the checkbox at the bottom of the popup.

**Feed chips are a lighter version of the score.** A thumbnail only carries
a video ID — YouTube doesn't send a channel's subscriber count until you
actually open the video — so feed chips blend **Quality + Engagement only**
(Reach is added back once you open the video and its subscriber count is
known). Hover a chip to see the breakdown and a reminder of what's missing.

To stay well under Return YouTube Dislike's published rate limit
(100 requests/minute), requests are queued and cached for 30 minutes in the
extension's background worker, shared across every open tab.

## The algorithm (v2)

```
FinalScore = 0.40 × Net Like Rate
           + 0.20 × Reach
           + 0.10 × Vote Confidence
           + 0.10 × Engagement
           + 0.20 × Maturity                              (0–10 scale)
```

| Component | What it measures | How |
|---|---|---|
| **Net Like Rate (40%)** | What fraction of the *whole audience* left a net-positive reaction | `(likes − dislikes) / views`. The primary signal — distinguishes "a few people voted, mostly positively" from "a large share of viewers felt strongly enough to react," which neither Vote Confidence nor Engagement can do alone. |
| **Reach (20%)** | Is this big *for this channel*? | `views / subscribers`, log-scaled. **Excluded entirely for Shorts** — they're pushed to a much broader non-subscriber audience by design, so even a real subscriber count would make an ordinary Short look artificially viral against a scale built for regular videos. |
| **Vote Confidence (10%)** | Is the like:dislike split statistically trustworthy? | Wilson 95% confidence lower bound (unchanged method), but recalibrated: on YouTube, ~90%+ like ratios are the *norm* for ordinary content — largely driven by a channel's existing loyal fanbase voting reflexively — so 90% now maps to "average," not "excellent." |
| **Engagement (10%)** | Did viewers actively react? | `(likes + dislikes + comments) / views`. Content flagged as passively consumed / rewatched-without-revoting (official music uploads, detected via standard upload boilerplate) uses a separately calibrated, more lenient curve, since a song replayed fifty times only ever contributes one vote. |
| **Maturity (20%)** | Has this video had time to prove itself? | A curve over days-since-publish, reaching "settled" around a month old. A brand-new video's numbers can be temporarily inflated by YouTube's own promotional push to a sample audience, or just not yet reflect its natural audience — the same idea as Vote Confidence's small-sample handling, applied to *time* instead of *vote count*. |

**Known tradeoff:** an already-exceptional video that's only a few days old will still score lower than it will once it's proven itself over ~a month, even if nothing else about it changes — that's the direct, intended effect of weighting Maturity at 20%.

**Top 4 of 5 (long-form only):** when all five components are available for a regular (non-Short) video, the single lowest-scoring one is dropped and its weight redistributed across the rest — one weak dimension shouldn't sink an otherwise strong video. Doesn't apply to Shorts (Reach is already excluded there) or when fewer than 5 components are available to begin with.

Any component whose input is unavailable (no subscriber count, or no parseable upload date) has its weight redistributed proportionally across the rest, rather than silently counting as zero.

**Confidence badge:** shown separately from the score, based on total vote count (Low / Moderate / High) — a 5-vote video and a 300,000-vote video at the same percentage aren't equally reliable, even after all of the above.

You can rebalance all five weights live in the popup ("Adjust weights") — the score recalculates instantly and your preference is saved.

## Where the data comes from

- **Views, subscriber count, comment count, title** — read directly from the
  YouTube watch page you're already viewing (no API key required).
- **Likes / dislikes** — from the [Return YouTube Dislike](https://returnyoutubedislike.com)
  open API. YouTube removed public dislike counts in December 2021; this is
  the standard crowdsourced/estimated replacement dataset that other
  dislike-restoring extensions also use. This extension is **not affiliated**
  with Return YouTube Dislike, YouTube, or Google, and links back to
  returnyoutubedislike.com per their API's attribution requirement.

## Known limitations

- **YouTube is a single-page app.** If you click from one video to another
  without a full page reload, the page's embedded data isn't refreshed. Use
  the **"Reload & analyze"** button in the popup to force a fresh read.
- **Return YouTube Dislike coverage isn't universal.** Very new, very obscure,
  or age-restricted videos may not have vote data yet. On the watch page the
  popup says so; on feed thumbnails, the chip simply doesn't appear rather
  than showing a distracting "no data" tag on every unrated card.
- **Feed chips omit Reach and comment count** — see above — so they're a
  slightly more conservative estimate than the full watch-page score for the
  same video.
- **Subscriber/comment counts can be hidden by the creator**, in which case
  those parts of the score are omitted rather than faked.
- Scraping relies on YouTube's internal page data structure and shadow DOM,
  both of which YouTube changes without notice; if a future redesign breaks
  extraction, the popup shows an error rather than a wrong number, and feed
  chips simply stop appearing rather than showing wrong ones.

## Files

```
manifest.json    Manifest V3 config
rating.js        Pure scoring engine (Wilson score, engagement/reach curves)
pagedata.js      Shared page-data extraction, used by both content.js and feed.js
content.js       Watch/Shorts-player scraping + full on-page badge
feed.js          Scans Home/sidebar/Shorts thumbnails and badges them lazily
content.css      Badge + thumbnail-chip styling
background.js    Rate-limited, cached proxy for the Return YouTube Dislike API
popup.html/.css/.js   The extension popup UI (score, weights, feed toggle)
icons/           Extension icons
```
