# Delivery roadmap

## Phase 0 — YouTube-first interaction prototype

Goal: validate that Browse, Mix, and Play make sense before integrating live video.

- Build the three-mode shell.
- Begin with mock thumbnails, then connect pasted YouTube URLs through a single provider adapter.
- Implement segment start/end editing.
- Implement dedicated draggable tracks for each loaded source.
- Implement ordered sequential playback; retain the source-track model for future overlaps.
- Test the click and keyboard paths with users.

Exit condition: a new user can create and play a short YouTube arrangement without explanation. The complete requirements are in the [first-build brief](first-build.md).

## Phase 1 — Reliable pasted YouTube sources

Goal: prove the concept with official embedded players and no search credentials.

- Parse pasted YouTube URLs into video IDs.
- Load and preview videos with the IFrame Player API.
- Validate embeddability and availability.
- Add readiness and buffering states.
- Measure synchronization drift.
- Save and restore projects locally.
- Add an off-by-default experimental overlap flag.

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
- Refine live number-key recording with timing and buffering feedback.
- Add JSON project export and import.

## Phase 3A — Local precision sources

Goal: add real overlapping audio after the YouTube-first interaction has been validated.

- Add local audio and video file tiles.
- Use Web Audio for accurate scheduling and gain control.
- Generate waveforms for local audio only.
- Add built-in rights-cleared samples.
- Reconnect local files when a saved project is reopened.

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
3. Arrange them in a clear sequence on the timeline.
4. Press Play.
5. Observe whether the experience feels musical despite transition delay and buffering.

This experiment answers the riskiest product question before investing in search, precise local-file mixing, accounts, or sharing. A two-player overlap remains a separate feature-flagged experiment.
