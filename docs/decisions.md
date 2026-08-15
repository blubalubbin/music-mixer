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

