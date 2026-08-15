# Delivery roadmap

## Phase 0 — Interaction prototype

Goal: validate that Browse, Mix, and Play make sense before integrating live video.

- Build the three-mode shell.
- Use nine mock video thumbnails and simulated players.
- Implement segment start/end editing.
- Implement a two-lane draggable timeline.
- Implement ordered playback with overlaps.
- Test the click and keyboard paths with users.

Exit condition: a new user can create and play a short arrangement without explanation.

## Phase 1 — Pasted YouTube sources

Goal: prove the concept with official embedded players and no search credentials.

- Parse pasted YouTube URLs into video IDs.
- Load and preview videos with the IFrame Player API.
- Validate embeddability and availability.
- Add readiness and buffering states.
- Measure synchronization drift.
- Save and restore projects locally.

Exit condition: a user can build a reliable short mix from pasted URLs on the supported browser.

## Phase 2 — In-app search

Goal: make source discovery feel integrated.

- Add a protected YouTube Data API search endpoint.
- Return video-only, embeddable results.
- Add result preview and assignment to a source slot.
- Define quota, caching, and error behavior.

Exit condition: a user can fill all nine slots without leaving the app.

## Phase 3 — Expressive mixing

Goal: make overlaps sound intentional.

- Add per-segment volume.
- Add fade-in and fade-out handles.
- Add optional snapping.
- Record live number-key triggers into the timeline.
- Add JSON project export and import.

## Phase 4 — Sharing and collaboration

Only pursue after platform-policy and playback reliability review.

- Shareable project definitions.
- Read-only playback links.
- Source replacement for unavailable videos.
- Attribution and rights guidance.

## First bounded experiment

Build only this flow:

1. Paste three YouTube URLs.
2. Define one segment from each.
3. Arrange them on two lanes with one overlap.
4. Press Play.
5. Observe whether the experience feels musical despite player drift.

This experiment answers the riskiest product question before investing in search, accounts, or sharing.

