# Source strategy

## Direction

Music Mixer is **YouTube-first**. The first build should prove that people can choose moments from YouTube videos, arrange them, and play a compelling audiovisual sequence without learning professional editing software.

Other source types remain useful, but they should not delay or dilute that experiment.

## Source comparison

| Source | Useful in a tile | Timing | Overlap potential | Intended role |
| --- | --- | --- | --- | --- |
| YouTube | Yes | Approximate | Experimental and policy-sensitive | Primary first-build source |
| Local audio | Yes | Precise | Excellent | Later precision-audio source |
| Local video | Yes | Good to precise | Good | Later precision-video source |
| Built-in samples | Yes | Precise | Excellent | Later onboarding and rhythm aid |
| Microphone recording | Yes | Precise after capture | Excellent | Later original-content source |
| Direct media URL | Sometimes | Good when CORS permits | Good | Later advanced source |
| SoundCloud | Technically promising | Approximate | Requires validation | Possible experiment |
| Spotify | Reference only | Not applicable to mixing | Unsuitable | Discovery and deep links |
| Apple Music | Reference only initially | Not applicable to mixing | Unsuitable or uncertain | Discovery and deep links |

## YouTube

### First-build capabilities

- Paste a YouTube watch, share, Shorts, or embed URL.
- Extract and store the video ID.
- Load the video through the official IFrame Player API.
- Read playback position and state.
- Set segment start and end timestamps.
- Preview one segment.
- Arrange segment instances on a timeline.
- Play an ordered sequence.
- Display clear buffering, autoplay-blocked, unavailable, and unembeddable states.

### Constraints

The [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) is designed for controlled embedded playback, not for embedding the full youtube.com browsing experience. Browse mode must therefore provide URL paste initially and app-owned search later.

Playback across separate embedded players is not sample-accurate. Overlaps should be treated as experimental until timing and platform-policy behavior have been measured. YouTube's [required minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) also places restrictions on automatic playback and how embedded players may be presented.

The first build should support a robust sequential path before depending on simultaneous audible playback.

## Local files

Local files are a strong future source because the browser can access files explicitly chosen through a file picker or drag and drop. Audio files can be decoded and scheduled using the [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API), enabling tighter timing, real overlaps, gain control, waveform analysis, and fades.

Potential formats include MP3, WAV, AAC/M4A where supported, OGG/Opus, MP4, and WebM.

Local files would remain on the user's machine unless the user deliberately exports or uploads them. Projects would need to reconnect files after reopening or store manageable files in browser storage.

This is a later capability, not part of the first YouTube build.

## Built-in samples and microphone

A future rights-cleared sample set could provide drum hits, loops, ambience, transitions, and silence. Browser microphone capture could add voice, percussion, or environmental sound. Once recorded, these sources could use the same precise local-audio engine.

These sources are valuable for expressive mixing but are out of scope until YouTube sequencing works.

## SoundCloud

The [SoundCloud Widget API](https://developers.soundcloud.com/docs/api/html5-widget) exposes play, pause, seek, position, duration, and volume controls. It may be suitable for approximate streamed segments, but synchronization, multi-widget behavior, content availability, and current platform terms require a dedicated experiment.

## Spotify

Spotify provides authenticated browser playback and seeking for eligible Premium users, but its published platform notes prohibit altering Spotify content and synchronizing recordings with visual media. It is therefore unsuitable as a segment-mixing source. See Spotify's [seek endpoint and policy notes](https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track).

A future Spotify tile could display metadata, retain a reference link, or help locate a song outside the mixer. It should be labelled as a **reference**, not a mixable source.

## Apple Music

[MusicKit on the Web](https://developer.apple.com/musickit/) can search and stream Apple Music content in a website, but it introduces subscriptions, user authorization, developer tokens, private signing credentials, and service-specific playback constraints.

Because a private signing key cannot live in a public GitHub Pages repository, a full Apple Music integration would also require a protected service for token generation. The initial role should be metadata, discovery, and deep linking rather than segment mixing.

## Capability model

Each provider should declare capabilities so the interface never promises controls the source cannot support:

```ts
type SourceCapabilities = {
  canSeek: boolean;
  canSetSegmentBounds: boolean;
  canAdjustVolume: boolean;
  canOverlap: boolean;
  canAnalyzeWaveform: boolean;
  canPersistOffline: boolean;
  timing: "precise" | "approximate" | "reference-only";
};
```

Initial YouTube capability values:

```ts
const youtubeCapabilities: SourceCapabilities = {
  canSeek: true,
  canSetSegmentBounds: true,
  canAdjustVolume: true,
  canOverlap: false,
  canAnalyzeWaveform: false,
  canPersistOffline: false,
  timing: "approximate",
};
```

`canOverlap` remains `false` in the supported first-build path. Experimental overlap work should be feature-flagged until it is technically and policy validated.

## Provider priority

1. YouTube URL paste and embedded playback.
2. YouTube app-owned search.
3. Local audio and video files.
4. Built-in samples and microphone recording.
5. SoundCloud experiment.
6. Spotify and Apple Music reference integrations.

