# Changelog

## v2.3.0 — Absolute dates, bare channel IDs, blanket search-dropdown fix
- Fixed Maturity still failing on the watch page: the live-DOM fallback only recognized relative dates ("4h ago"), never absolute ones ("Jul 28, 2022") — confirmed directly from a screenshot showing that exact format going unmatched
- Date extraction is now pattern-based (matches the *shape* of a date) instead of depending on specific JSON field names, which have proven unstable across redesigns — applied to both feed items and the watch page
- Fixed Reach staying "n/a" on thumbnails: found a real bug — YouTube often stores a channel ID as a bare string (`UCxxxxx`) with no `/channel/` prefix, which the URL-matching regex required and therefore never matched
- Fixed a bug in my own subscriber-count parser: it was returning "7" instead of "7,240,000" for "7.24M subscribers" due to a regex that matched even without an actual word multiplier present
- Search-dropdown badge: rather than continuing to guess at the exact DOM container, now hides *all* badges the instant the search box gains focus and restores them when it loses focus
- Thumbnail badge moved from top-left to top-right corner, avoiding YouTube's own NEW/LIVE/4K indicators which commonly occupy top-left; also reduced its z-index from an unnecessarily high value to a more conservative one

## v2.2.0 — Date parsing, search-dropdown, subscriber fallback
- Fixed Maturity failing almost everywhere: date parser only understood spelled-out units ("4 hours ago"), not YouTube's abbreviated feed/sidebar format ("4h ago", "1mo ago")
- Fixed badges still appearing in the search suggestions dropdown: scanning now pauses entirely while the search box has focus, rather than trying to exclude one specific floating preview element
- Added a subscriber-count fallback: when a video's own data doesn't include it (common for sidebar/search results), fetches the channel's own YouTube page in the background (not a third-party service) and reads it from there — capped per session on the feed side to avoid excessive fetching while scrolling

## v2.1.0 — Live-DOM fallbacks
- Fixed Maturity/Reach showing "n/a" on the watch page: YouTube moved to a new `ytContentMetadataViewModel` structure the JSON parser didn't recognize; added a live-DOM text fallback that reads whatever is actually rendered
- Fixed badges reappearing in search bar/sidebar: excluded those containers explicitly
- Fixed star overlaying Shorts video content: broadened the search scope for the channel/Subscribe row, since it can be a sibling rather than a child of the active video element

## v2.0.0 — New scoring algorithm
- Replaced 3-component algorithm with 5-component model:
  **Net Like Rate 40%, Reach 20%, Vote Confidence 10%, Engagement 10%, Maturity 20%**
- Added **Net Like Rate**: `(likes − dislikes) / views` — primary signal
- Recalibrated Vote Confidence (was "Quality") and Engagement curves against realistic YouTube norms (~90% likes = average, not excellent) instead of a naive 0–100% scale
- Added **Maturity**: video-age curve, addresses new/unproven videos vs. "saturated" ones
- **Reach now always excluded for Shorts** (previously only when subscriber count was missing) — Shorts reach non-subscribers by design
- Added music/passive-content detection with a separate, more lenient Engagement curve
- Fixed: Reach showing "n/a" on watch pages despite a visible subscriber count (metadata lookup wasn't matching the page's own video)
- Popup UI updated: 5 weight sliders, 5 score bars, new stats (upload age, content type)
- Fixed: popup's fallback script injection was missing `pagedata.js`/`feed.js`

## v1.1.3 — Placement & data fixes
- Fixed regular (non-Shorts) thumbnails sometimes not getting badges at all
- Fixed badge stuck in a fallback position until manual reload (now retries until the best anchor is found)
- Fixed inconsistent Shorts badge position
- Fixed Reach showing "n/a" despite visible subscriber count

## v1.1.2 — Duplicate/avatar fixes
- Fixed avatar-shaped elements still occasionally getting badged (removed flawed size-comparison logic)
- Fixed intermittent duplicate ratings appearing on hover (added global per-video dedup)

## v1.1.1 — Major stability fixes
- Fixed Shorts badge floating over the video image (moved to in-flow placement)
- Fixed badges disappearing from the whole feed (shape-check ran before layout settled)
- Fixed rating vanishing after a full page reload (separated fetch retry from placement retry)
- Fixed badges wrongly appearing on channel avatars, sidebar, and search suggestions
- Fixed a stray "unavailable" badge appearing on non-watch pages

## v1.1.0 — Feed ratings
- Added rating badges to Home feed, sidebar, search results, and Shorts shelf thumbnails
- Added feed-rating on/off toggle in the popup

## v1.0.0 — Initial release
- Chrome extension rating YouTube videos on a 0–10 scale
- Algorithm: Quality 50% (Wilson score), Engagement 30%, Reach 20%
- On-page badge near the like/dislike buttons
- Data from the Return YouTube Dislike API + page scraping
- Popup with score breakdown and adjustable weights
