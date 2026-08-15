# First-build brief

## Objective

Build a GitHub Pages-compatible YouTube-first prototype that proves the complete Browse → Mix → Play loop with pasted YouTube URLs.

## User story

As a music fan, I can assign YouTube videos to numbered tiles, capture short timestamped segments, arrange those segments, and play the resulting audiovisual sequence from beginning to end.

## Supported first-build path

1. Open an empty nine-tile project.
2. Select a tile or press its number key.
3. Paste a YouTube URL.
4. Preview and assign the video to the tile.
5. Enter Mix mode.
6. Set a segment's start and end timestamps.
7. Add the segment to the timeline.
8. Repeat with at least three sources.
9. Reorder the segments.
10. Enter Play mode and play the sequence.

## Functional requirements

### Project shell

- Three modes: Browse, Mix, and Play.
- Nine persistent source slots numbered `1` through `9`.
- Tile number and color remain consistent across every mode.
- Responsive desktop-first layout suitable for GitHub Pages.

### Browse

- Accept common YouTube URL forms.
- Reject invalid URLs with a useful message.
- Load an official YouTube embedded player.
- Assign or replace the active tile's source.
- Return to the nine-tile grid without losing other sources.

### Mix

- Select a populated source.
- Display the player's current time.
- Set start and end timestamps from the current time or typed values.
- Validate that start is non-negative and end is greater than start.
- Preview the bounded segment.
- Add, select, move, trim, duplicate, and delete segment instances.
- Display segments using their source number and color.

The timeline may visually support two lanes, but simultaneous audible overlap is not required for the supported first build.

### Play

- Begin only after an explicit user action.
- Play segments sequentially according to arrangement time.
- Show the active source, current segment, next segment, playhead, elapsed time, and remaining time.
- Support pause, resume, and stop.
- Recover visibly from buffering, autoplay blocking, unavailable videos, and player errors.

### Persistence

- Save project source IDs and segment definitions in browser storage.
- Restore the most recent project after refresh.
- Provide JSON export and import if time permits; this is the preferred portability mechanism for a static GitHub Pages app.

## Non-goals

- Full YouTube search.
- Spotify or Apple Music playback.
- Local-file mixing.
- Beat detection or tempo matching.
- Waveforms.
- Rendered audio/video export.
- Guaranteed simultaneous playback.
- Accounts, collaboration, or cloud project storage.

## Acceptance criteria

- A user can populate at least three tiles using pasted URLs.
- A user can create at least one valid segment from each populated tile.
- A user can reorder segments and understand their source identity.
- Play mode runs the full sequence without manual source switching.
- Reloading restores the project definition.
- The production build works from a repository subpath such as `/music-mixer/`.
- No API keys, tokens, credentials, or copyrighted media files are committed.
- Keyboard shortcuts do not fire while focus is inside a text input.
- Errors are shown in the interface rather than only in the developer console.

## Experimental flag

An `experimentalOverlap` feature flag may enable two-lane concurrent playback for local testing. It must default to off in the published build until YouTube policy compatibility, browser behavior, and drift have been reviewed.

## Build order

1. Static mode shell and nine-tile state.
2. YouTube URL parsing and player adapter.
3. Segment editor and validation.
4. Arrangement data model and timeline.
5. Sequential scheduler.
6. Browser persistence.
7. Error and buffering states.
8. Keyboard controls and accessibility.
9. GitHub Pages production build and subpath verification.
10. Optional experimental overlap spike.

