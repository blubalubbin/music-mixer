# Decisions and open questions

## Current decisions

### Nine sources use keys 1–9

The visible source grid and keyboard mapping should match. Key `0` is reserved for a global action such as stop.

### Browse is app-owned

The product will not attempt to place the full YouTube website inside a tile. It will provide search or URL paste, then load the selected video into an official embedded player.

### The timeline is the source of truth

Segments are ordered by arrangement time, not by the order they were captured. Overlap is represented by segments sharing time across separate lanes.

### Playback is useful, not sample-accurate

The first release aims for convincing audiovisual sequencing. It does not promise beat-perfect synchronization across independently streamed videos.

### Prototype before integrating APIs

The first implementation should validate the interaction using mock players. This keeps product-learning work separate from buffering and API problems.

### YouTube remains the first source

The first build uses pasted YouTube URLs and the official embedded player. Local files may later provide precise mixing, but they do not replace the YouTube-first product experiment.

### Source capabilities are explicit

Each source provider declares whether it supports seeking, segment bounds, volume, overlap, waveform analysis, offline persistence, and precise timing. The interface must not display unsupported controls.

### Spotify and Apple Music begin as references

Spotify's platform restrictions and Apple Music's authentication and token requirements make them unsuitable for the first mixing engine. Future integrations may provide metadata, discovery, and deep links.

### Sequential playback is the supported baseline

The timeline may represent multiple lanes, but the published first build guarantees only one active audible YouTube source. Concurrent playback remains behind an off-by-default experimental flag until policy and technical behavior are validated.

## Open product questions

- Is the primary output a visual mixtape, an audio-focused mashup, or both equally?
- During an overlap, should both videos remain visible, crossfade, or use a chosen layout?
- Should overlapping audio play at equal volume by default or automatically duck one source?
- Does pressing a number in Mix mode select a source, trigger it, or depend on an explicit capture state?
- Should play mode permit live improvisation or reproduce only the saved arrangement?
- What should happen when an overlap source buffers but the main source is ready?

## Open technical questions

- What synchronization drift is observed on the supported browsers and typical connections?
- How many concurrent player instances are reliable on low-powered devices?
- Can inactive players remain preloaded without violating performance or platform expectations?
- What server-side approach best protects the YouTube Data API key and manages quota?
- Which project fields will be needed for future format migrations?

## Decision log template

Use this format when an open question is resolved:

```md
### YYYY-MM-DD — Decision title

- Decision:
- Why:
- Alternatives considered:
- Consequences:
```
