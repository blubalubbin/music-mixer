# Product specification

## Product promise

Make it easy for a person with no music-production experience to collect moments from online videos and arrange them into a short audiovisual mix.

## Intended user

A music fan, teacher, creator, or casual performer who understands playlists and keyboard shortcuts but may not understand tracks, buses, waveforms, or other studio terminology.

## Jobs to be done

- Find or paste videos that contain moments worth reusing.
- Save the exact part of a video that should appear in the mix.
- Arrange moments without learning professional editing software.
- Hear and see how two moments work when they overlap.
- Play the result from beginning to end without manually operating each video.

## Product principles

1. **Collect before arranging.** Browse mode is for choosing sources; Mix mode is for editing them.
2. **Use spatial memory.** A video remains attached to the same numbered tile and color throughout the app.
3. **Show time visually.** The timeline makes order, duration, and overlap visible.
4. **Keep expert controls optional.** Every keyboard action has a visible point-and-click equivalent.
5. **Make buffering visible.** Playback should never silently drift or wait without explanation.

## Modes

### Browse

The overview displays a `3 × 3` grid of source tiles numbered `1` through `9`.

Selecting a tile opens a focused source picker. In the first build, the user can:

- paste a YouTube URL;
- preview the video;
- assign the chosen video to the active slot; or
- return to the grid without changing it.

The full YouTube website is not embedded inside a tile. The product provides its own source-picker interface and loads the chosen video in an official embedded player. App-owned YouTube search is a later enhancement.

### Mix

The source grid remains visible above a simple arrangement timeline.

Selecting a tile opens its segment controls:

- current playback time;
- start time;
- end time;
- preview segment;
- add segment to arrangement; and
- delete or duplicate segment.

Segments inherit the source number and color. The product vision supports:

- drag-to-reorder;
- trim start and end;
- one dedicated track for each loaded video source;
- horizontal overlap;
- snapping that can be disabled for fine timing; and
- a playhead for previewing the arrangement.

The supported first build uses this timeline model but plays YouTube segments sequentially. Parallel audible playback remains experimental.

### Play

Play mode reduces editing controls and emphasizes the current video, the next segment, elapsed time, remaining time, and a stop control.

The timeline remains visible as a progress map. The first build emphasizes the current and upcoming segments. The broader vision may show and mix both sources during an overlap after that behavior has been validated.

## Keyboard model

The first release should avoid assigning two unrelated meanings to a number key at the same time.

| Context | `1`–`9` action |
| --- | --- |
| Browse grid | Open that source slot |
| Mix, nothing recording | Trigger that source from the chosen start and begin recording |
| Mix, recording | Close the current moment and trigger the selected source |
| Play | Optional live trigger, disabled by default |

`0` is reserved for a global action such as stop, rather than representing a tenth source in a nine-tile layout.

## Minimum viable product

- Nine numbered source slots.
- Add a source by pasted YouTube URL.
- Create a segment with start and end timestamps.
- Arrange segments in order.
- Display dedicated source tracks while playing YouTube segments sequentially.
- Save the project locally in the browser.
- Preview a segment.
- Play the arrangement with clear buffering and error states.

## Later possibilities

- YouTube search inside the app.
- Crossfade curves and per-segment volume.
- Quantization or beat snapping.
- Keyboard performance recording.
- Shareable mix definitions.
- Project export/import as JSON.
- Alternative media sources that allow tighter timing or audio analysis.
- Feature-flagged simultaneous YouTube overlap, subject to technical and policy validation.

## Out of scope for the first release

- Downloading or extracting YouTube media.
- Exporting a rendered audio or video file.
- Beat-perfect synchronization guarantees.
- More than nine simultaneous sources.
- A full professional multitrack editor.
