import "./styles.css";
import {
  EMPTY_PROJECT,
  SLOT_COLORS,
  formatTime,
  parseMixProject,
  parseYouTubeId,
  segmentDuration,
  totalDuration,
  type MixProject,
  type Mode,
  type Segment,
  type Source,
} from "./model";

const STORAGE_KEY = "music-mixer-project-v1";
const FRAME_BUFFERING_KEY = "music-mixer-frame-buffering-v1";
const DYNAMIC_PAN_ZOOM_KEY = "music-mixer-dynamic-pan-zoom-v1";
const INSERTION_PAN_ZOOM_KEY = "music-mixer-insertion-pan-zoom-v1";
const app = document.querySelector<HTMLDivElement>("#app")!;

let project = loadProject();
let lastSavedProject = structuredClone(project);
const undoStack: MixProject[] = [];
const redoStack: MixProject[] = [];
const HISTORY_LIMIT = 100;
let mode: Mode = "mix";
let selectedSlot = project.sources[0]?.slot ?? 1;
let editingSlot: number | null = null;
let message = "";
let transferMessage = "";
let mixFocusContext: "video" | "timeline" = "video";
let timelineSettingsOpen = false;
let startValue = 0;
let endValue = 8;
let playing = false;
let playStartedAt = 0;
let pausedAt = totalDuration(project.segments);
let animationFrame = 0;
let activePlaybackIndex = project.segments.length - 1;
let playerGeneration = 0;
let playerReady = false;
let loadedVideoId: string | null = null;
let loadedVideoHasFrame = false;
let bufferedArrangementSegmentId: string | null = null;
let pauseWhenFrameAvailable = false;
let arrangementPlaybackTransitioning = false;
let frameBufferingEnabled = localStorage.getItem(FRAME_BUFFERING_KEY) !== "off";
type PanZoomMode = "dynamic" | "gesture";
const savedPanZoomMode = localStorage.getItem(DYNAMIC_PAN_ZOOM_KEY);
let panZoomMode: PanZoomMode = savedPanZoomMode === "off" || savedPanZoomMode === "manual"
  ? "gesture"
  : savedPanZoomMode === "gesture" ? "gesture" : "dynamic";
const savedInsertionPanZoomMode = localStorage.getItem(INSERTION_PAN_ZOOM_KEY);
let insertionPanZoomMode: PanZoomMode = savedInsertionPanZoomMode === "gesture" || savedInsertionPanZoomMode === "manual" || savedInsertionPanZoomMode === "off"
  ? "gesture"
  : "dynamic";
let sourceVideoPlaying = false;
let activeVideoDuration = 0;
let segmentDefinitionFrame = 0;
let previewEndFrame = 0;
let previewStopAtEnd: number | null = null;
let youtubePlayer: YouTubePlayer | null = null;
let youtubeApiPromise: Promise<void> | null = null;
let captureSlot: number | null = null;
let captureSourceStart = 0;
let captureSegmentId: string | null = null;
let pendingCaptureSlot: number | null = null;
let timelineZoom = 18;
let preferredTimelineZoom = 18;
const TIMELINE_COLUMN_MIN_WIDTH = 12;
const TIMELINE_COLUMN_GAP = 6;
const TIMELINE_MAX_ZOOM = 50; // 2 seconds per 100 pixels
const TIMELINE_MIN_ZOOM = 0.05; // 20 seconds per pixel
const TIMELINE_ZOOM_OUT_RANGE = 2; // allow twice the fit-to-screen seconds per pixel
const ADJACENT_PAIR_TRACK_BUDGET = 0.5;
const CONTIGUOUS_SOURCE_EPSILON_SECONDS = 0.05;
const BUFFERED_FRAME_MATCH_TOLERANCE_SECONDS = 0.75;
let timelineHeadLocked = true;
let initialTimelineFramed = false;
let arrangementScrollLeft = 0;
let suppressArrangementScrollSync = false;
let arrangementScrollSyncTimer = 0;
let timelineResizeTimer = 0;
let lastTimelinePanSeekAt = -Infinity;
let timelinePanActive = false;
const selectedMomentIds = new Set<string>();
let suppressNextMomentClick = false;
let suppressNextTimelineSeek = false;
let lastAddedMomentId: string | null = null;
let navigationRailCollapsed = false;

type YouTubePlayer = {
  cueVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  loadVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
};

type YouTubeNamespace = {
  Player: new (elementId: string, options: Record<string, unknown>) => YouTubePlayer;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

function loadProject(): MixProject {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return structuredClone(EMPTY_PROJECT);
    const parsed = JSON.parse(saved) as MixProject;
    return parsed.version === 1 && Array.isArray(parsed.sources) && Array.isArray(parsed.segments)
      ? parsed
      : structuredClone(EMPTY_PROJECT);
  } catch {
    return structuredClone(EMPTY_PROJECT);
  }
}

function saveProject() {
  if (JSON.stringify(project) !== JSON.stringify(lastSavedProject)) {
    undoStack.push(structuredClone(lastSavedProject));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    lastSavedProject = structuredClone(project);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undo = document.querySelector<HTMLButtonElement>("#undo-project");
  const redo = document.querySelector<HTMLButtonElement>("#redo-project");
  if (undo) undo.disabled = undoStack.length === 0;
  if (redo) redo.disabled = redoStack.length === 0;
}

function undoProject() {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(structuredClone(project));
  restoreProjectSnapshot(previous);
}

function redoProject() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(structuredClone(project));
  restoreProjectSnapshot(next);
}

function restoreProjectSnapshot(snapshot: MixProject) {
  playing = false;
  captureSlot = null;
  captureSegmentId = null;
  pendingCaptureSlot = null;
  cancelAnimationFrame(animationFrame);
  cancelAnimationFrame(segmentDefinitionFrame);
  youtubePlayer?.pauseVideo();
  project = structuredClone(snapshot);
  lastSavedProject = structuredClone(snapshot);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  selectedMomentIds.clear();
  lastAddedMomentId = null;
  pausedAt = totalDuration(project.segments);
  activePlaybackIndex = Math.max(0, project.segments.length - 1);
  selectedSlot = project.sources.some((source) => source.slot === selectedSlot) ? selectedSlot : (project.sources[0]?.slot ?? 1);
  render();
}

function sourceForSlot(slot: number) {
  return project.sources.find((source) => source.slot === slot);
}

function sourceForSegment(segment: Segment) {
  return project.sources.find((source) => source.id === segment.sourceId);
}

function setMode(nextMode: Mode) {
  stopPlayback();
  mode = nextMode;
  editingSlot = null;
  message = "";
  render();
}

function render() {
  app.innerHTML = `
    <div class="app-shell ${navigationRailCollapsed ? "rail-collapsed" : ""}">
      <header class="topbar">
        <a class="brand" href="#" aria-label="Music Mixer home">
          <span class="brand-mark"><i></i><i></i><i></i><i></i></span>
          <span class="brand-label">MUSIC<br>MIXER</span>
        </a>
        <nav class="modes" aria-label="Workspace mode">
          ${(["browse", "mix", "play"] as Mode[]).map((item, index) => `
            <button class="mode ${mode === item ? "active" : ""}" data-mode="${item}" title="${item[0].toUpperCase() + item.slice(1)}">
              <span class="mode-number">0${index + 1}</span><span class="mode-icon" aria-hidden="true">${item === "browse" ? "▦" : item === "mix" ? "≋" : "▶"}</span><span class="mode-label">${item}</span>
            </button>`).join("")}
        </nav>
        <div class="project-meta">
          <span class="save-state"><i></i> Saved locally</span>
          <input id="project-title" aria-label="Project title" value="${escapeHtml(project.title)}" />
        </div>
      </header>
      <main>${mode === "browse" ? browseView() : mode === "mix" ? mixView() : playView()}</main>
    </div>`;
  bindEvents();
  queueMicrotask(() => {
    mountPlayerForCurrentView();
    if (mode === "mix") updateKeyboardContextHelp(mixFocusContext);
    const tracks = document.querySelector<HTMLElement>(".source-tracks");
    if (tracks) syncTimelineGutters(tracks);
    if (mode === "mix" && project.segments.length && !initialTimelineFramed) frameInitialTimeline();
    else if (mode === "mix") restoreArrangementScroll();
  });
}

function browseView() {
  if (editingSlot !== null) return sourcePicker(editingSlot);
  const count = project.sources.length;
  return `
    <section class="workspace browse-workspace">
      <div class="section-heading">
        <div><p class="eyebrow">BUILD YOUR PALETTE</p><h1>Choose your sources.</h1></div>
        <p class="lede">Nine slots. Nine colors. Paste a YouTube link to give each key a sound and a visual.</p>
      </div>
      <div class="source-grid">
        ${Array.from({ length: 9 }, (_, index) => sourceTile(index + 1)).join("")}
      </div>
      <footer class="workspace-footer">
        <span><b>${count}</b> of 9 sources loaded</span>
        <span>Press <kbd>1</kbd>–<kbd>9</kbd> to open a slot</span>
        ${project.segments.length ? `<button class="restart-timeline" id="restart-timeline" type="button">Restart timeline</button>` : ""}
        <button class="primary" data-mode="mix" ${count ? "" : "disabled"}>Start mixing <span>→</span></button>
      </footer>
    </section>`;
}

function sourceTile(slot: number, compact = false) {
  const source = sourceForSlot(slot);
  const color = SLOT_COLORS[slot - 1];
  const tile = `
    <button class="source-tile ${source ? "filled" : "empty"} ${compact ? "compact" : ""} ${selectedSlot === slot ? "selected" : ""}"
      style="--slot-color:${color}" data-slot="${slot}" aria-label="${source ? `Edit slot ${slot}, ${escapeHtml(source.title)}` : `Add video to slot ${slot}`}">
      <span class="slot-number">${slot}</span>
      ${source ? `
        <img src="https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg" alt="" />
        <span class="tile-shade"></span><span class="tile-title">${escapeHtml(source.title)}</span>
      ` : `<span class="plus">+</span><span class="empty-label">Add a video</span>`}
    </button>`;
  if (compact) return tile;
  return `<div class="source-tile-shell">${tile}${source ? `<button class="source-delete" data-source-delete="${slot}" type="button" aria-label="Delete source ${slot}, ${escapeHtml(source.title)}">Delete</button>` : ""}</div>`;
}

function sourcePicker(slot: number) {
  const source = sourceForSlot(slot);
  return `
    <section class="workspace picker-workspace">
      <button class="back-link" id="close-picker">← Back to sources</button>
      <div class="picker-grid">
        <div class="picker-copy">
          <p class="eyebrow" style="color:${SLOT_COLORS[slot - 1]}">SOURCE ${slot}</p>
          <h1>${source ? "Replace this source." : "Give this key a video."}</h1>
          <p>Paste a YouTube watch, share, Shorts, live, or embed link. We’ll keep only the video reference.</p>
          <form id="source-form">
            <label for="youtube-url">YouTube URL</label>
            <div class="url-row"><input id="youtube-url" name="url" type="text" autocomplete="off" placeholder="https://youtu.be/…" value="${source?.originalUrl ?? ""}" /><button class="primary" type="submit">Use video</button></div>
            <label for="source-title">Your label <span>optional</span></label>
            <input id="source-title" name="title" type="text" maxlength="60" placeholder="e.g. Opening drums" value="${source?.title ?? ""}" />
            <p class="form-error" aria-live="polite">${message ? escapeHtml(message) : ""}</p>
          </form>
          <p class="fine-print">Playback uses YouTube’s official embedded player. Some private, removed, age-restricted, or embedding-disabled videos may not play here.</p>
        </div>
        <div class="preview-card" style="--slot-color:${SLOT_COLORS[slot - 1]}">
          <span class="preview-number">${slot}</span>
          ${source ? `<img src="https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg" alt="Preview for ${escapeHtml(source.title)}" /><div class="preview-caption"><b>${escapeHtml(source.title)}</b><span>${source.videoId}</span></div>` : `<div class="preview-empty"><span>▶</span><p>Your video preview<br>will appear here</p></div>`}
        </div>
      </div>
      <div class="source-dock">${Array.from({ length: 9 }, (_, index) => sourceTile(index + 1, true)).join("")}</div>
    </section>`;
}

function mixView() {
  const source = sourceForSlot(selectedSlot);
  return `
    <section class="workspace mix-workspace">
      <div class="editor-layout">
        <div class="video-preview-column">
          <section class="mock-player" style="--slot-color:${SLOT_COLORS[selectedSlot - 1]}">
            ${source ? `<div id="youtube-player" class="youtube-player"></div>` : `<div class="no-source"><span>${selectedSlot}</span><p>Add a video to this slot in Browse mode.</p><button class="text-button" data-mode="browse">Go to Browse →</button></div>`}
          </section>
          ${source ? segmentDefinitionRuler() : ""}
        </div>
        <section class="segment-editor segment-editor-right">
          <div class="segment-source-summary">
            <p class="eyebrow">SEGMENT FROM SOURCE ${selectedSlot}</p>
            <h2>${escapeHtml(source?.title ?? "Empty source")}</h2>
            ${source ? `<p class="mix-playback-status" role="status">Loading YouTube player…</p>` : ""}
            ${message ? `<p class="form-error" role="alert">${escapeHtml(message)}</p>` : ""}
            <div class="arrangement-summary">
              <p class="eyebrow">ARRANGEMENT</p>
              <h3 id="arrangement-summary-title">${project.segments.length ? `${project.segments.length} moments · ${formatTime(totalDuration(project.segments))}` : "Your mix is empty"}</h3>
              ${transferMessage ? `<p class="transfer-message" role="status">${escapeHtml(transferMessage)}</p>` : ""}
            </div>
          </div>
          <aside class="keyboard-context-help video-context" id="keyboard-context-help" aria-live="polite">
            <b>VIDEO FOCUS</b>
            <p>←/→ scrub 1s · Shift + ←/→ scrub 15s · 0 start · 1–9 scrub + mark · Space start/finish · Enter add · +/− zoom</p>
          </aside>
          <div class="segment-controls segment-actions">
            <button class="focus-toggle" id="mix-focus-toggle" type="button">Focus timeline <span>⇅</span></button>
            <button id="keyboard-capture" class="keyboard-capture" type="button">Keyboard ready · arrows scrub · Shift + arrows scrub 15s · Space start / finish</button>
            <button class="preview-button" id="preview-segment" ${source ? "" : "disabled"}>▶ Preview this clip with sound</button>
            <div class="guided-actions">
              <button class="guided-action" id="video-play-toggle" type="button" ${source ? "" : "disabled"}>Play video</button>
              <button class="guided-action" id="set-start" type="button" ${source ? "" : "disabled"}>Set playhead start</button>
              <button class="guided-action" id="set-end" type="button" ${source ? "" : "disabled"}>Set playhead end</button>
              <button class="primary wide" id="mix-primary-action" ${source ? "" : "disabled"}>Add to mix <span>＋</span></button>
            </div>
          </div>
          <div class="right-timeline-toolbar" id="right-timeline-toolbar">${timelineToolbar(timelineZoomBounds(document.querySelector<HTMLElement>(".source-tracks")))}</div>
        </section>
      </div>
      ${timelineView()}
    </section>`;
}

function timelineView() {
  const duration = totalDuration(project.segments);
  const sources = [...project.sources].sort((a, b) => a.slot - b.slot);
  const columnWidths = timelineColumnWidths();
  const columns = columnWidths.map((width) => `${width}px`).join(" ");
  const elapsed = currentElapsed();
  return `
    <section class="timeline-section">
      <div class="timeline source-tracks ${timelineHeadLocked ? "" : "head-unlocked"}" style="--track-count:${sources.length};--timeline-track-height:${34 + Math.min(sources.length, 4) * 49}px;--timeline-track-height-mobile:${34 + Math.min(sources.length, 4) * 43}px" tabindex="0" aria-label="Arrangement timeline. Use left and right arrows for previous and next segment, and Space to play from the current segment.">
        <div class="time-label">TIME</div><div class="time-axis" style="grid-template-columns:${columns || "minmax(190px, 1fr)"}">${timeAxisLabels(columnWidths)}</div>
        ${sources.map((source) => `<div class="track-label ${selectedSlot === source.slot ? "selected" : ""}" style="--slot-color:${SLOT_COLORS[source.slot - 1]}"><button class="track-select" data-slot="${source.slot}" title="Switch to ${escapeHtml(source.title)}"><b>${source.slot}</b><span>${escapeHtml(source.title)}</span></button><span class="track-actions"><button data-track-edit="${source.slot}" aria-label="Edit ${escapeHtml(source.title)}">Edit</button></span></div><div class="source-track" style="grid-template-columns:${columns || "minmax(190px, 1fr)"}" data-source="${source.id}">${project.segments.length ? project.segments.map((segment, index) => segment.sourceId === source.id ? segmentCard(segment, index) : `<span class="moment-gap" data-index="${index}" aria-hidden="true"></span>`).join("") : `<span class="track-empty">Press <kbd>${source.slot}</kbd> to record a moment</span>`}</div>`).join("")}
        ${groupRegions(columnWidths)}
        ${project.segments.length ? `<div class="pan-release-head" aria-hidden="true"><span>Release</span></div>` : ""}
        ${project.segments.length ? `<button class="arrangement-head ${playing ? "playing" : ""}" style="--head-x:${timelinePosition(elapsed, columnWidths)}px" type="button" aria-label="Drag arrangement preview head" aria-valuemin="0" aria-valuemax="${duration.toFixed(1)}" aria-valuenow="${elapsed.toFixed(1)}"></button>` : ""}
      </div>
      <button class="add-track-video" data-mode="browse"><span>＋</span> Add track video</button>
    </section>`;
}

function timelineToolbar(zoomBounds: { min: number; max: number }) {
  return `<div class="timeline-tools">
    <div class="timeline-history-controls" aria-label="Edit history">
      <button id="undo-project" type="button" ${undoStack.length ? "" : "disabled"} title="Undo (⌘Z / Ctrl+Z)"><span aria-hidden="true">↶</span> Undo</button>
      <button id="redo-project" type="button" ${redoStack.length ? "" : "disabled"} title="Redo (⌘⇧Z / Ctrl+Y)"><span aria-hidden="true">↷</span> Redo</button>
    </div>
    ${selectionTools()}
    ${project.segments.length ? `<div class="segment-navigation" aria-label="Segment navigation"><button id="previous-segment" type="button" ${activePlaybackIndex <= 0 ? "disabled" : ""}>Previous segment <kbd>←</kbd></button><button id="next-segment" type="button" ${activePlaybackIndex >= project.segments.length - 1 ? "disabled" : ""}>Next segment <kbd>→</kbd></button></div>` : ""}
    <div class="timeline-settings ${timelineSettingsOpen ? "open" : ""}">
      <button class="settings-cog" id="timeline-settings-toggle" type="button" aria-label="Timeline settings" aria-expanded="${timelineSettingsOpen}" aria-controls="timeline-settings-panel">⚙</button>
      <div class="settings-panel" id="timeline-settings-panel" ${timelineSettingsOpen ? "" : "hidden"}>
        <div class="settings-row"><span>Project</span><div class="project-transfer" aria-label="Import or export timeline"><button id="import-project" type="button">Import</button><button id="export-project" type="button" ${project.sources.length || project.segments.length ? "" : "disabled"}>Export</button><input id="project-file" type="file" accept="application/json,.json" hidden /></div></div>
        <div class="settings-row"><span>Moment zoom</span><div class="zoom-controls" aria-label="Moment zoom"><button id="zoom-out" aria-label="Zoom out" ${timelineZoom <= zoomBounds.min ? "disabled" : ""}>−</button><span>${formatTimelineZoomLabel(timelineZoom)}</span><button id="zoom-in" aria-label="Zoom in" ${timelineZoom >= zoomBounds.max ? "disabled" : ""}>＋</button></div></div>
        ${project.segments.length ? `<button class="pan-zoom-toggle ${panZoomMode}" id="pan-zoom-toggle" type="button" title="${panZoomModeTitle(panZoomMode, "playback")}">${panZoomModeLabel(panZoomMode, "Playback")}</button><button class="pan-zoom-toggle ${insertionPanZoomMode}" id="insertion-pan-zoom-toggle" type="button" title="${panZoomModeTitle(insertionPanZoomMode, "insertion")}">${panZoomModeLabel(insertionPanZoomMode, "Insertion")}</button><button class="frame-buffer-toggle ${frameBufferingEnabled ? "enabled" : ""}" id="frame-buffer-toggle" type="button" aria-pressed="${frameBufferingEnabled}">Frame buffering · ${frameBufferingEnabled ? "On" : "Off"}</button>` : ""}
      </div>
    </div>
  </div>`;
}

function selectionTools() {
  const count = selectedMomentIds.size;
  if (!count) return "";
  return `<div class="selection-tools" role="toolbar" aria-label="Selected moments"><span>${count} selected</span><button data-bulk-action="duplicate">Duplicate</button><button data-bulk-action="delete">Delete</button><button data-bulk-action="group" ${count < 2 ? "disabled" : ""}>Group</button><button data-bulk-action="ungroup">Ungroup</button></div>`;
}

function segmentDefinitionRuler() {
  const source = sourceForSlot(selectedSlot);
  const sourceSegments = source ? project.segments.filter((segment) => segment.sourceId === source.id) : [];
  const latestSegmentEnd = sourceSegments.reduce((maximum, segment) => Math.max(maximum, segment.sourceEndSeconds), 0);
  const total = Math.max(activeVideoDuration, endValue, latestSegmentEnd, 1);
  const startPercent = Math.min(100, Math.max(0, startValue / total * 100));
  const endPercent = Math.min(100, Math.max(startPercent, endValue / total * 100));
  return `<div class="segment-definition" aria-label="Segment from ${formatTime(startValue)} to ${formatTime(endValue)} of ${formatTime(total)}">
    <div class="definition-labels"><span>Clip range · ${sourceSegments.length} timeline moment${sourceSegments.length === 1 ? "" : "s"}</span><span>${formatTime(startValue)} → ${formatTime(endValue)} / ${formatTime(total)}</span></div>
    <div class="definition-ruler"><i style="left:${startPercent}%;width:${endPercent - startPercent}%"></i><button type="button" class="definition-start" data-range-bound="start" style="left:${startPercent}%" aria-label="Drag clip start, currently ${formatTime(startValue)}"><span>${formatTime(startValue)}</span></button><button type="button" class="definition-end" data-range-bound="end" style="left:${endPercent}%" aria-label="Drag clip end, currently ${formatTime(endValue)}"><span>${formatTime(endValue)}</span></button></div>
    <div class="source-segment-points" aria-label="Timeline moments from this source">${sourceSegments.map((segment, index) => {
      const left = Math.min(100, Math.max(0, segment.sourceStartSeconds / total * 100));
      const right = Math.min(100, Math.max(left, segment.sourceEndSeconds / total * 100));
      return `<span style="left:${left}%;width:${Math.max(0.2, right - left)}%" title="Moment ${index + 1}: ${formatTime(segment.sourceStartSeconds)} to ${formatTime(segment.sourceEndSeconds)}"><i></i><b></b></span>`;
    }).join("")}</div>
  </div>`;
}

function updateSegmentDefinitionRuler() {
  const current = document.querySelector<HTMLElement>(".segment-definition");
  if (!current) return;
  const shell = document.createElement("div");
  shell.innerHTML = segmentDefinitionRuler();
  current.replaceWith(shell.firstElementChild!);
}

function timeAxisLabels(widths: number[]) {
  let elapsed = 0;
  let pixels = 0;
  let lastLabelPixel = -Infinity;
  return project.segments.map((segment, index) => {
    const showLabel = index === 0 || pixels - lastLabelPixel >= 72;
    const label = showLabel ? `<span style="grid-column:${index + 1}"><i></i>${formatTimePrecise(elapsed)}</span>` : "";
    if (showLabel) lastLabelPixel = pixels;
    elapsed += segmentDuration(segment);
    pixels += widths[index] + 6;
    return label;
  }).join("");
}

function formatTimePrecise(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

function formatZoomScale(zoom: number) {
  const seconds = 100 / zoom;
  const precision = seconds < 1 ? 2 : seconds < 10 ? 1 : 0;
  return `${seconds.toFixed(precision)}s/100px`;
}

function formatTimelineZoomLabel(zoom: number, tracks = document.querySelector<HTMLElement>(".source-tracks")) {
  if (captureSlot === null && panZoomMode === "gesture") {
    const total = totalDuration(project.segments);
    let secondsOnScreen = total;
    if (tracks && project.segments.length) {
      const track = tracks.querySelector<HTMLElement>(".source-track");
      const coveredLeft = track?.offsetLeft ?? 0;
      const contentOrigin = timelineContentOrigin(tracks);
      const visibleStart = Math.max(0, tracks.scrollLeft + coveredLeft - contentOrigin);
      const visibleEnd = Math.max(visibleStart, tracks.scrollLeft + tracks.clientWidth - contentOrigin);
      const widths = timelineColumnWidths(zoom);
      secondsOnScreen = Math.max(
        0,
        timelineElapsedAtPosition(visibleEnd, widths) - timelineElapsedAtPosition(visibleStart, widths),
      );
    } else if (total) {
      const labelWidth = window.innerWidth <= 850 ? 105 : 155;
      secondsOnScreen = Math.min(total, Math.max(0, window.innerWidth - labelWidth) / zoom);
    }
    return `${formatTime(secondsOnScreen)} on screen`;
  }
  return formatZoomScale(zoom);
}

function panningTimeLabels(elapsed: number) {
  const boundedElapsed = Math.max(0, Math.min(totalDuration(project.segments), elapsed));
  const index = findSegmentIndex(boundedElapsed);
  const segment = project.segments[index];
  const timelineLabel = `TL ${formatTime(boundedElapsed)}`;
  if (!segment) return [timelineLabel, "YT —"];
  const youtubeTime = segment.sourceStartSeconds + Math.max(0, boundedElapsed - segmentStart(index));
  return [timelineLabel, `YT ${formatTime(youtubeTime)}`];
}

function timelineColumnWidths(zoom = timelineZoom) {
  return project.segments.map((segment) => Math.max(TIMELINE_COLUMN_MIN_WIDTH, segmentDuration(segment) * zoom));
}

function timelinePosition(elapsed: number, widths = timelineColumnWidths()) {
  let timeCursor = 0;
  let pixelCursor = 0;
  for (let index = 0; index < project.segments.length; index += 1) {
    const duration = segmentDuration(project.segments[index]);
    if (elapsed <= timeCursor + duration) return pixelCursor + widths[index] * Math.max(0, elapsed - timeCursor) / duration;
    timeCursor += duration;
    pixelCursor += widths[index] + 6;
  }
  return pixelCursor;
}

function groupRegions(widths: number[]) {
  const regions: string[] = [];
  let index = 0;
  while (index < project.segments.length) {
    const groupId = project.segments[index].groupId;
    if (!groupId) { index += 1; continue; }
    const start = index;
    while (index + 1 < project.segments.length && project.segments[index + 1].groupId === groupId) index += 1;
    const end = index;
    if (end > start) {
      const left = widths.slice(0, start).reduce((sum, width) => sum + width + 6, 0);
      const width = widths.slice(start, end + 1).reduce((sum, item) => sum + item, 0) + (end - start) * 6;
      const source = sourceForSegment(project.segments[start]);
      regions.push(`<div class="group-region" style="--group-left:${left}px;--group-width:${width}px;--group-color:${SLOT_COLORS[(source?.slot ?? 1) - 1]}" aria-hidden="true"></div>`);
    }
    index += 1;
  }
  return regions.join("");
}

function segmentCard(segment: Segment, index: number) {
  const source = sourceForSegment(segment);
  const slot = source?.slot ?? 1;
  const duration = segmentDuration(segment);
  return `<article class="segment ${selectedMomentIds.has(segment.id) ? "selected" : ""} ${segment.groupId ? "grouped" : ""} ${lastAddedMomentId === segment.id ? "last-added" : ""} ${captureSegmentId === segment.id ? "capturing" : ""} ${index === activePlaybackIndex ? "under-head" : ""} ${playing && index === activePlaybackIndex ? "currently-playing" : ""}" style="--slot-color:${SLOT_COLORS[slot - 1]};--segment-width:${Math.min(520, Math.max(190, duration * 18))}px" data-segment="${segment.id}" data-index="${index}" ${segment.groupId ? `data-group="${segment.groupId}"` : ""}>
    <span class="segment-index">${String(index + 1).padStart(2, "0")}</span><b>${slot}</b>
    ${segment.groupId ? `<span class="group-badge" title="Grouped moment">G</span>` : ""}
    <span class="segment-label" title="YouTube start ${formatTime(segment.sourceStartSeconds)} · length ${duration.toFixed(1)} seconds">${formatTime(segment.sourceStartSeconds)} · ${duration.toFixed(1)}s</span>
    <button data-action="duplicate" data-id="${segment.id}" aria-label="Duplicate segment">⧉</button>
    <button data-action="delete" data-id="${segment.id}" aria-label="Delete segment">×</button>
    <div class="duration-bar" aria-label="${duration.toFixed(1)} second moment">
      <button class="trim-handle trim-start" data-trim="start" data-id="${segment.id}" aria-label="Drag to change segment start"></button>
      <span><i></i><span class="trim-crop trim-crop-start"></span><span class="trim-crop trim-crop-end"></span><em>${duration.toFixed(1)}s</em>${lastAddedMomentId === segment.id ? `<small class="head-insert-note">Added at timeline head</small>` : ""}</span>
      <button class="trim-handle trim-end" data-trim="end" data-id="${segment.id}" aria-label="Drag to change segment end"></button>
    </div>
  </article>`;
}

function playView() {
  const elapsed = currentElapsed();
  const total = totalDuration(project.segments);
  const active = activeSegmentAt(elapsed);
  const activeIndex = active ? project.segments.indexOf(active) : -1;
  const source = active ? sourceForSegment(active) : undefined;
  return `
    <section class="workspace play-workspace">
      <div class="performance-label"><span>PERFORMANCE MODE</span><i class="${playing ? "live" : ""}"></i>${playing ? "Playing" : elapsed ? "Paused" : "Ready"}</div>
      <div class="stage" style="--slot-color:${source ? SLOT_COLORS[source.slot - 1] : "#777"}">
        ${source ? `<div id="youtube-player" class="youtube-player"></div><div class="stage-shade"></div><div class="now-playing"><span>NOW PLAYING · SOURCE ${source.slot}</span><h1>${escapeHtml(source.title)}</h1><p>${formatTime(active!.sourceStartSeconds)} → ${formatTime(active!.sourceEndSeconds)}</p></div><p class="playback-status" role="status">Press play to hear this clip</p>` : `<div class="empty-stage"><p>${project.segments.length ? "Press play to begin your mix." : "Your mix needs at least one segment."}</p></div>`}
      </div>
      <div class="transport">
        <span>${formatTime(elapsed)}</span><div class="progress"><i style="width:${total ? Math.min(100, elapsed / total * 100) : 0}%"></i></div><span>−${formatTime(Math.max(0, total - elapsed))}</span>
        <button id="play-toggle" class="play-button" ${project.segments.length ? "" : "disabled"}>${playing ? "Ⅱ" : "▶"}</button>
        <button id="stop" class="stop-button" aria-label="Stop">■</button>
      </div>
      <div class="up-next"><span>UP NEXT</span>${project.segments.slice(activeIndex + 1, activeIndex + 4).map((segment, index) => { const next = sourceForSegment(segment); return `<div><b style="background:${next ? SLOT_COLORS[next.slot - 1] : "#777"}">${next?.slot ?? "?"}</b><span>${escapeHtml(next?.title ?? "Missing source")}<small>in ${formatTime(Math.max(0, segmentStart(activeIndex + 1 + index) - elapsed))}</small></span></div>`; }).join("") || `<p>End of mix</p>`}</div>
      <button class="back-to-mix" data-mode="mix">← Back to Mix</button>
    </section>`;
}

function bindEvents() {
  document.querySelector("#restart-timeline")?.addEventListener("click", restartTimeline);
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode as Mode)));
  document.querySelectorAll<HTMLElement>("[data-slot]").forEach((tile) => tile.addEventListener("click", () => selectSlot(Number(tile.dataset.slot))));
  document.querySelectorAll<HTMLElement>("[data-track-edit]").forEach((button) => button.addEventListener("click", () => editTrack(Number(button.dataset.trackEdit))));
  document.querySelectorAll<HTMLElement>("[data-source-delete]").forEach((button) => button.addEventListener("click", () => deleteTrack(Number(button.dataset.sourceDelete))));
  document.querySelector("#close-picker")?.addEventListener("click", () => { editingSlot = null; message = ""; render(); });
  document.querySelector<HTMLFormElement>("#source-form")?.addEventListener("submit", assignSource);
  document.querySelector<HTMLInputElement>("#project-title")?.addEventListener("change", (event) => { project.title = (event.target as HTMLInputElement).value.trim() || "Untitled mix"; saveProject(); render(); });
  document.querySelector("#mix-primary-action")?.addEventListener("click", runMixPrimaryAction);
  document.querySelector("#mix-focus-toggle")?.addEventListener("click", toggleMixFocus);
  document.querySelector("#preview-segment")?.addEventListener("click", previewSegment);
  document.querySelector("#video-play-toggle")?.addEventListener("click", toggleSourceVideoPlayback);
  document.querySelector("#set-start")?.addEventListener("click", () => setBoundFromPlayer("start"));
  document.querySelector("#set-end")?.addEventListener("click", setEndFromPlayer);
  document.querySelector(".video-preview-column")?.addEventListener("pointerdown", beginClipRangeDrag);
  document.querySelector<HTMLInputElement>("#start-time")?.addEventListener("input", updateTimeValues);
  document.querySelector<HTMLInputElement>("#end-time")?.addEventListener("input", updateTimeValues);
  bindTimelineEvents(document);
  document.querySelector("#play-toggle")?.addEventListener("click", togglePlayback);
  document.querySelector("#stop")?.addEventListener("click", () => { stopPlayback(); render(); });
  bindTimelineControls(document);
}

function beginClipRangeDrag(event: Event) {
  const pointerEvent = event as PointerEvent;
  if (pointerEvent.button !== 0) return;
  const handle = (pointerEvent.target as HTMLElement).closest<HTMLElement>("[data-range-bound]");
  const ruler = handle?.closest<HTMLElement>(".definition-ruler");
  if (!handle || !ruler) return;
  pointerEvent.preventDefault();
  const bound = handle.dataset.rangeBound as "start" | "end";
  const total = Math.max(activeVideoDuration, endValue, 1);
  handle.setPointerCapture(pointerEvent.pointerId);
  handle.classList.add("dragging");

  const move = (moveEvent: PointerEvent) => {
    const bounds = ruler.getBoundingClientRect();
    const time = Math.max(0, Math.min(total, (moveEvent.clientX - bounds.left) / Math.max(1, bounds.width) * total));
    if (bound === "start") startValue = Math.min(Math.max(0, time), Math.max(0, endValue - 0.1));
    else endValue = Math.max(Math.min(total, time), Math.min(total, startValue + 0.1));
    startValue = Number(startValue.toFixed(1));
    endValue = Number(endValue.toFixed(1));
    updateClipRangeDisplay(total);
  };
  const end = () => {
    handle.classList.remove("dragging");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    updateSegmentDefinitionRuler();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function updateClipRangeDisplay(total: number) {
  const definition = document.querySelector<HTMLElement>(".segment-definition");
  const ruler = definition?.querySelector<HTMLElement>(".definition-ruler");
  if (!definition || !ruler) return;
  const startPercent = Math.min(100, Math.max(0, startValue / total * 100));
  const endPercent = Math.min(100, Math.max(startPercent, endValue / total * 100));
  const range = ruler.querySelector<HTMLElement>("i");
  const start = ruler.querySelector<HTMLButtonElement>(".definition-start");
  const end = ruler.querySelector<HTMLButtonElement>(".definition-end");
  if (range) { range.style.left = `${startPercent}%`; range.style.width = `${endPercent - startPercent}%`; }
  if (start) { start.style.left = `${startPercent}%`; start.setAttribute("aria-label", `Drag clip start, currently ${formatTime(startValue)}`); }
  if (end) { end.style.left = `${endPercent}%`; end.setAttribute("aria-label", `Drag clip end, currently ${formatTime(endValue)}`); }
  const labels = definition.querySelectorAll<HTMLElement>(".definition-labels span");
  if (labels[1]) labels[1].textContent = `${formatTime(startValue)} → ${formatTime(endValue)} / ${formatTime(total)}`;
}

function bindTimelineControls(root: ParentNode) {
  root.querySelector("#undo-project")?.addEventListener("click", undoProject);
  root.querySelector("#redo-project")?.addEventListener("click", redoProject);
  root.querySelector("#timeline-settings-toggle")?.addEventListener("click", toggleTimelineSettings);
  root.querySelector("#export-project")?.addEventListener("click", exportProject);
  root.querySelector("#import-project")?.addEventListener("click", () => root.querySelector<HTMLInputElement>("#project-file")?.click());
  root.querySelector<HTMLInputElement>("#project-file")?.addEventListener("change", importProject);
  root.querySelector("#previous-segment")?.addEventListener("click", () => navigateSegment(-1));
  root.querySelector("#next-segment")?.addEventListener("click", () => navigateSegment(1));
  root.querySelector("#pan-zoom-toggle")?.addEventListener("click", togglePanZoomMode);
  root.querySelector("#insertion-pan-zoom-toggle")?.addEventListener("click", toggleInsertionPanZoomMode);
  root.querySelector("#frame-buffer-toggle")?.addEventListener("click", toggleFrameBuffering);
  root.querySelector("#zoom-out")?.addEventListener("click", () => changeTimelineZoom(-4));
  root.querySelector("#zoom-in")?.addEventListener("click", () => changeTimelineZoom(4));
  root.querySelector<HTMLElement>(".source-tracks")?.addEventListener("scroll", (event) => {
    const tracks = event.currentTarget as HTMLElement;
    arrangementScrollLeft = tracks.scrollLeft;
    const activelyDragging = tracks.classList.contains("panning") || Boolean(tracks.querySelector(".arrangement-head.dragging, .segment.dragging"));
    if (!activelyDragging && !suppressArrangementScrollSync && !playing && captureSlot === null && project.segments.length) {
      pausedAt = elapsedAtCenteredHead(tracks);
      activePlaybackIndex = findSegmentIndex(pausedAt);
      adaptTimelineZoomAtHead(tracks, pausedAt);
      seekTimelinePreviewThrottled(pausedAt);
      const head = tracks.querySelector<HTMLElement>(".arrangement-head");
      head?.setAttribute("aria-valuenow", pausedAt.toFixed(1));
      updateActiveTimelineMoment();
    }
  }, { passive: true });
  root.querySelector<HTMLElement>(".arrangement-head")?.addEventListener("pointerdown", beginArrangementScrub);
  root.querySelector<HTMLElement>(".source-tracks")?.addEventListener("pointerdown", beginTimelinePan);
  root.querySelector<HTMLElement>(".source-tracks")?.addEventListener("click", seekArrangementFromTimelineClick);
}

function toggleTimelineSettings() {
  timelineSettingsOpen = !timelineSettingsOpen;
  const settings = document.querySelector<HTMLElement>(".timeline-settings");
  const toggle = document.querySelector<HTMLButtonElement>("#timeline-settings-toggle");
  const panel = document.querySelector<HTMLElement>("#timeline-settings-panel");
  settings?.classList.toggle("open", timelineSettingsOpen);
  toggle?.setAttribute("aria-expanded", String(timelineSettingsOpen));
  if (panel) panel.hidden = !timelineSettingsOpen;
}

function runMixPrimaryAction() {
  if (mixFocusContext === "timeline") toggleArrangementPlayback();
  else addSegment();
}

function toggleMixFocus() {
  if (mixFocusContext === "video") {
    document.querySelector<HTMLElement>(".source-tracks")?.focus({ preventScroll: true });
  } else {
    document.querySelector<HTMLButtonElement>("#keyboard-capture")?.focus({ preventScroll: true });
  }
}

function updateMixFocusToggle() {
  const button = document.querySelector<HTMLButtonElement>("#mix-focus-toggle");
  if (!button) return;
  const destination = mixFocusContext === "video" ? "timeline" : "video";
  button.innerHTML = `Focus ${destination} <span>⇅</span>`;
  button.setAttribute("aria-label", `Move focus to ${destination}`);
}

function updateMixPrimaryAction() {
  const button = document.querySelector<HTMLButtonElement>("#mix-primary-action");
  if (!button) return;
  if (mixFocusContext === "timeline") {
    button.disabled = project.segments.length === 0;
    button.innerHTML = playing ? `Pause arrangement <span>Ⅱ</span>` : `Play arrangement <span>▶</span>`;
  } else {
    button.disabled = !sourceForSlot(selectedSlot);
    button.innerHTML = `Add to mix <span>＋</span>`;
  }
}

function updateGuidedVideoActions() {
  const play = document.querySelector<HTMLButtonElement>("#video-play-toggle");
  const start = document.querySelector<HTMLButtonElement>("#set-start");
  const end = document.querySelector<HTMLButtonElement>("#set-end");
  const add = document.querySelector<HTMLButtonElement>("#mix-primary-action");
  if (!play || !start || !end || !add) return;
  const videoContext = mixFocusContext === "video";
  const activeCapture = captureSlot !== null;
  const freePlaying = sourceVideoPlaying && !activeCapture;
  const startReady = !sourceVideoPlaying && !activeCapture;
  [play, start, end, add].forEach((button) => button.classList.remove("guided-active", "guided-muted"));
  if (videoContext) {
    [play, start, end, add].forEach((button) => button.classList.add("guided-muted"));
    const next = activeCapture ? end : freePlaying ? play : startReady ? start : null;
    next?.classList.remove("guided-muted");
    next?.classList.add("guided-active");
  }
  play.textContent = sourceVideoPlaying ? (freePlaying ? "Pause video · Space" : "Pause video") : "Play video";
  start.textContent = startReady && videoContext ? "Set playhead start · Space" : "Set playhead start";
  end.textContent = activeCapture && videoContext ? "Set playhead end · Space" : "Set playhead end";
}

function toggleSourceVideoPlayback() {
  if (!youtubePlayer || !playerReady) {
    setPlaybackStatus("The active video is still loading");
    return;
  }
  if (sourceVideoPlaying) {
    if (captureSlot !== null) finishLiveCapture(youtubePlayer.getCurrentTime());
    youtubePlayer.pauseVideo();
    sourceVideoPlaying = false;
    setPlaybackStatus("Paused");
  } else {
    previewStopAtEnd = null;
    cancelAnimationFrame(previewEndFrame);
    youtubePlayer.playVideo();
    sourceVideoPlaying = true;
    setPlaybackStatus("Playing video with sound");
  }
  updateGuidedVideoActions();
}

function setEndFromPlayer() {
  if (captureSlot !== null && youtubePlayer) finishLiveCapture(youtubePlayer.getCurrentTime());
  setBoundFromPlayer("end");
  sourceVideoPlaying = false;
  updateGuidedVideoActions();
}

function exportProject() {
  const blob = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(project.title)}.music-mixer.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  transferMessage = `Exported ${project.segments.length} moment${project.segments.length === 1 ? "" : "s"} and ${project.sources.length} source URL${project.sources.length === 1 ? "" : "s"}.`;
  render();
}

async function importProject(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const parsed = parseMixProject(JSON.parse(await file.text()) as unknown);
    if (!parsed.ok) throw new Error(parsed.error);
    if ((project.sources.length || project.segments.length) && !window.confirm("Import this project and replace the current timeline and source videos? You can undo this change.")) return;
    stopPlayback();
    project = parsed.project;
    saveProject();
    selectedMomentIds.clear();
    lastAddedMomentId = null;
    selectedSlot = project.sources[0]?.slot ?? 1;
    pausedAt = 0;
    activePlaybackIndex = 0;
    initialTimelineFramed = false;
    transferMessage = `Imported ${project.segments.length} moment${project.segments.length === 1 ? "" : "s"} and ${project.sources.length} source URL${project.sources.length === 1 ? "" : "s"}.`;
    render();
  } catch (error) {
    transferMessage = `Import failed: ${error instanceof Error ? error.message : "invalid project file"}`;
    render();
  } finally {
    input.value = "";
  }
}

function safeFileName(value: string) {
  return value.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "untitled-mix";
}

function panZoomModeLabel(value: PanZoomMode, context: "Playback" | "Insertion") {
  return `${context} zoom · ${value === "dynamic" ? "Dynamic" : "Fixed"}`;
}

function panZoomModeTitle(value: PanZoomMode, context: "playback" | "insertion") {
  if (value === "dynamic") return `Adapt zoom automatically during segment ${context}`;
  return `Keep zoom fixed during segment ${context}`;
}

function setPanZoomMode(nextMode: PanZoomMode, applyDynamicZoom = true) {
  panZoomMode = nextMode;
  localStorage.setItem(DYNAMIC_PAN_ZOOM_KEY, panZoomMode);
  preferredTimelineZoom = timelineZoom;
  const button = document.querySelector<HTMLButtonElement>("#pan-zoom-toggle");
  if (button) {
    button.classList.remove("dynamic", "gesture");
    button.classList.add(panZoomMode);
    button.title = panZoomModeTitle(panZoomMode, "playback");
    button.textContent = panZoomModeLabel(panZoomMode, "Playback");
  }
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (panZoomMode === "gesture" && tracks) {
    timelineZoom = clampTimelineZoom(timelineZoom, tracks);
    preferredTimelineZoom = timelineZoom;
    applyTimelineZoomInPlace(tracks, pausedAt);
  } else if (panZoomMode === "dynamic" && applyDynamicZoom && tracks && project.segments.length) {
    adaptTimelineZoomAtHead(tracks, pausedAt);
  }
}

function togglePanZoomMode() {
  const nextMode: PanZoomMode = panZoomMode === "dynamic" ? "gesture" : "dynamic";
  setPanZoomMode(nextMode);
}

function toggleInsertionPanZoomMode() {
  insertionPanZoomMode = insertionPanZoomMode === "dynamic" ? "gesture" : "dynamic";
  localStorage.setItem(INSERTION_PAN_ZOOM_KEY, insertionPanZoomMode);
  const button = document.querySelector<HTMLButtonElement>("#insertion-pan-zoom-toggle");
  if (button) {
    button.classList.remove("dynamic", "gesture");
    button.classList.add(insertionPanZoomMode);
    button.title = panZoomModeTitle(insertionPanZoomMode, "insertion");
    button.textContent = panZoomModeLabel(insertionPanZoomMode, "Insertion");
  }
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (captureSlot !== null && tracks) {
    if (insertionPanZoomMode === "dynamic") adaptTimelineZoomAtHead(tracks, pausedAt);
    else applyTimelineZoomInPlace(tracks, pausedAt);
  }
}

function activePanZoomMode() {
  return captureSlot === null ? panZoomMode : insertionPanZoomMode;
}

function toggleFrameBuffering() {
  frameBufferingEnabled = !frameBufferingEnabled;
  localStorage.setItem(FRAME_BUFFERING_KEY, frameBufferingEnabled ? "on" : "off");
  if (!frameBufferingEnabled && pauseWhenFrameAvailable) {
    pauseWhenFrameAvailable = false;
    youtubePlayer?.pauseVideo();
  }
  const button = document.querySelector<HTMLButtonElement>("#frame-buffer-toggle");
  if (!button) return;
  button.classList.toggle("enabled", frameBufferingEnabled);
  button.setAttribute("aria-pressed", String(frameBufferingEnabled));
  button.textContent = `Frame buffering · ${frameBufferingEnabled ? "On" : "Off"}`;
}

function navigateSegment(direction: -1 | 1) {
  if (!project.segments.length) return;
  const currentIndex = activePlaybackIndex < 0 ? (direction > 0 ? -1 : 0) : activePlaybackIndex;
  const targetIndex = Math.max(0, Math.min(project.segments.length - 1, currentIndex + direction));
  if (targetIndex === currentIndex) return;
  const resumePlayback = playing;
  if (resumePlayback) {
    playing = false;
    cancelAnimationFrame(animationFrame);
  }
  activePlaybackIndex = targetIndex;
  pausedAt = segmentStart(targetIndex);
  updatePlayUi(pausedAt);
  centerArrangementOnElapsed(pausedAt, true);
  cueArrangementAtPausedPosition(resumePlayback);
}

function restartTimeline() {
  const momentCount = project.segments.length;
  if (!momentCount || !window.confirm(`Restart the timeline? This will permanently remove all ${momentCount} moment${momentCount === 1 ? "" : "s"}. Your source videos will stay available.`)) return;
  cancelAnimationFrame(segmentDefinitionFrame);
  captureSegmentId = null;
  captureSlot = null;
  pendingCaptureSlot = null;
  youtubePlayer?.pauseVideo();
  stopPlayback();
  project.segments = [];
  selectedMomentIds.clear();
  lastAddedMomentId = null;
  arrangementScrollLeft = 0;
  timelineZoom = 18;
  preferredTimelineZoom = 18;
  initialTimelineFramed = false;
  saveProject();
  render();
}

function seekArrangementFromTimelineClick(event: MouseEvent) {
  if (event.shiftKey || suppressNextTimelineSeek) return;
  const target = event.target as HTMLElement;
  if (target.closest("button, .trim-handle, .arrangement-head") || !target.closest(".source-track, .segment, .moment-gap, .time-axis")) return;
  const tracks = event.currentTarget as HTMLElement;
  const position = Math.max(0, event.clientX - tracks.getBoundingClientRect().left + tracks.scrollLeft - timelineContentOrigin(tracks));
  if (playing) {
    playing = false;
    cancelAnimationFrame(animationFrame);
    youtubePlayer?.pauseVideo();
    updatePlaybackButtons();
  }
  pausedAt = Math.min(totalDuration(project.segments), timelineElapsedAtPosition(position));
  activePlaybackIndex = findSegmentIndex(pausedAt);
  updatePlayUi(pausedAt);
  centerArrangementOnElapsed(pausedAt, true);
  cueArrangementAtPausedPosition(false);
}

function timelineElapsedAtPosition(position: number, widths = timelineColumnWidths()) {
  let timeCursor = 0;
  let pixelCursor = 0;
  for (let index = 0; index < project.segments.length; index += 1) {
    const duration = segmentDuration(project.segments[index]);
    const width = widths[index];
    if (position <= pixelCursor + width) return timeCursor + duration * Math.max(0, position - pixelCursor) / width;
    timeCursor += duration;
    pixelCursor += width + 6;
  }
  return totalDuration(project.segments);
}

function beginArrangementScrub(event: PointerEvent) {
  if (event.button !== 0 || !project.segments.length) return;
  event.preventDefault();
  const head = event.currentTarget as HTMLElement;
  const tracks = head.closest<HTMLElement>(".source-tracks");
  if (!tracks) return;
  const resumeAfterDrag = playing;
  if (playing) pausedAt = currentElapsed();
  playing = false;
  cancelAnimationFrame(animationFrame);
  youtubePlayer?.pauseVideo();
  updatePlaybackButtons();
  head.classList.add("dragging");
  head.setPointerCapture(event.pointerId);

  let lastClientX = event.clientX;
  const headViewportX = timelineHeadViewportX(tracks);
  const update = (clientX: number) => {
    tracks.scrollLeft -= clientX - lastClientX;
    lastClientX = clientX;
    pausedAt = elapsedAtCenteredHead(tracks, headViewportX);
    activePlaybackIndex = findSegmentIndex(pausedAt);
    updatePlayUi(pausedAt);
    head.setAttribute("aria-valuenow", pausedAt.toFixed(1));
  };

  const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
  const end = () => {
    head.removeEventListener("pointermove", move);
    head.removeEventListener("pointerup", end);
    head.removeEventListener("pointercancel", end);
    head.classList.remove("dragging");
    cueArrangementAtPausedPosition(resumeAfterDrag);
  };
  head.addEventListener("pointermove", move);
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

function beginTimelinePan(event: PointerEvent) {
  if (event.button !== 0 || event.shiftKey || event.altKey || !project.segments.length) return;
  const target = event.target as HTMLElement;
  const startedOnOnlySegment = project.segments.length === 1 && Boolean(target.closest(".segment"));
  if (target.closest("button, .track-label, .time-label, .trim-handle, .arrangement-head") || (!startedOnOnlySegment && target.closest(".segment"))) return;
  event.preventDefault();
  const tracks = event.currentTarget as HTMLElement;
  tracks.focus({ preventScroll: true });
  const panDuringPlayback = playing;
  const previousHeadLocked = timelineHeadLocked;
  if (panDuringPlayback) {
    timelinePanActive = true;
    timelineHeadLocked = false;
    tracks.classList.add("head-unlocked");
  } else {
    timelineHeadLocked = true;
    tracks.classList.remove("head-unlocked");
    pausedAt = elapsedAtCenteredHead(tracks, tracks.clientWidth / 2);
    activePlaybackIndex = findSegmentIndex(pausedAt);
    updatePlayUi(pausedAt);
  }
  const originX = event.clientX;
  const originY = event.clientY;
  let gestureOriginZoom = timelineZoom;
  let gestureOriginY = event.clientY;
  const gestureZoomBounds = timelineZoomBounds(tracks);
  lastTimelinePanSeekAt = -Infinity;
  let lastClientX = event.clientX;
  let lastClientY = event.clientY;
  let visualPanRoll = 0;
  let visualZoomRoll = 0;
  const headViewportX = timelineHeadViewportX(tracks);
  let dragging = false;
  let gestureMode: "pan" | "zoom" | null = null;
  let activeDialOriginX = event.clientX;
  let activeDialOriginY = event.clientY;
  let perpendicularOriginX = event.clientX;
  let perpendicularOriginY = event.clientY;
  let previousActiveControlTravel = 0;
  let dotTracksPerpendicular = true;
  let controlEngaged = false;
  let dialContractionSuppressed = false;
  let directionRearmed = false;
  let zoomAnchorElapsed = panDuringPlayback ? currentElapsed() : pausedAt;
  let gestureIndicator: HTMLDivElement | null = null;
  const gestureSelectionRadius = 18;
  const gestureCrossoverRadius = 22;
  tracks.setPointerCapture(event.pointerId);

  const move = (moveEvent: PointerEvent) => {
    if (!dragging && Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) < 4) return;
    dragging = true;
    const horizontalTravel = Math.abs(moveEvent.clientX - originX);
    const verticalDistance = Math.abs(moveEvent.clientY - originY);
    const originDistance = Math.hypot(horizontalTravel, verticalDistance);
    const zoomIntent = verticalDistance / Math.max(1, horizontalTravel + verticalDistance);
    let nextGestureMode = gestureMode;
    let activeDialDeltaX = moveEvent.clientX - activeDialOriginX;
    let activeDialDeltaY = moveEvent.clientY - activeDialOriginY;
    const activeAxisDistance = Math.abs(gestureMode === "pan" ? activeDialDeltaX : activeDialDeltaY);
    if (panZoomMode === "gesture" && controlEngaged && activeAxisDistance < 30) {
      // Treat re-entry as a fresh press: discard the previous axis and make
      // this pointer position the local origin for the next wall crossing.
      activeDialOriginX = moveEvent.clientX;
      activeDialOriginY = moveEvent.clientY;
      perpendicularOriginX = moveEvent.clientX;
      perpendicularOriginY = moveEvent.clientY;
      activeDialDeltaX = 0;
      activeDialDeltaY = 0;
      previousActiveControlTravel = 0;
      dotTracksPerpendicular = true;
      controlEngaged = false;
      dialContractionSuppressed = false;
      directionRearmed = true;
      nextGestureMode = null;
    } else if (panZoomMode === "gesture" && directionRearmed) {
      const reachedHorizontalWall = Math.abs(activeDialDeltaX) >= 30;
      const reachedVerticalWall = Math.abs(activeDialDeltaY) >= 30;
      if (reachedHorizontalWall || reachedVerticalWall) {
        nextGestureMode = reachedVerticalWall && Math.abs(activeDialDeltaY) > Math.abs(activeDialDeltaX)
          ? "zoom"
          : "pan";
        directionRearmed = false;
      }
    } else if (panZoomMode === "gesture" && gestureMode && activeAxisDistance <= gestureCrossoverRadius) {
      directionRearmed = true;
      if (gestureMode === "pan" && zoomIntent >= 0.6) nextGestureMode = "zoom";
      else if (gestureMode === "zoom" && zoomIntent <= 0.4) nextGestureMode = "pan";
      if (nextGestureMode !== gestureMode) directionRearmed = false;
    } else if (gestureMode) {
      directionRearmed = false;
    } else if (panZoomMode === "gesture" && !gestureMode && originDistance > gestureSelectionRadius) {
      if (zoomIntent >= 0.6) nextGestureMode = "zoom";
      else if (zoomIntent <= 0.4) nextGestureMode = "pan";
      if (nextGestureMode) directionRearmed = false;
    }
    if (nextGestureMode && nextGestureMode !== gestureMode) {
      // A re-armed gesture already has the correct origin at the dead-zone
      // centre. Preserve it so touching the wall engages immediately.
      if (gestureMode !== null) {
        activeDialOriginX = moveEvent.clientX;
        activeDialOriginY = moveEvent.clientY;
        perpendicularOriginX = moveEvent.clientX;
        perpendicularOriginY = moveEvent.clientY;
      }
      previousActiveControlTravel = 0;
      dotTracksPerpendicular = true;
      controlEngaged = false;
      dialContractionSuppressed = false;
    }
    activeDialDeltaX = moveEvent.clientX - activeDialOriginX;
    activeDialDeltaY = moveEvent.clientY - activeDialOriginY;
    const activeControlTravel = Math.abs(nextGestureMode === "zoom" ? activeDialDeltaY : activeDialDeltaX);
    const nextControlEngaged = panZoomMode !== "gesture" || Boolean(nextGestureMode && activeControlTravel >= 30);
    const panStartScrollLeft = Math.max(0, timelineContentOrigin(tracks) - headViewportX);
    const panEndScrollLeft = Math.max(
      panStartScrollLeft,
      timelineContentOrigin(tracks) + timelinePosition(totalDuration(project.segments)) - headViewportX
    );
    const activeControlAtLimit = nextGestureMode === "zoom"
      ? (activeDialDeltaY < 0
          ? timelineZoom >= gestureZoomBounds.max
          : timelineZoom <= gestureZoomBounds.min)
      : nextGestureMode === "pan"
        ? (activeDialDeltaX < 0
            ? tracks.scrollLeft >= panEndScrollLeft - 0.01
            : tracks.scrollLeft <= panStartScrollLeft + 0.01)
        : false;
    if (nextControlEngaged && !controlEngaged) {
      // Suppress contraction only when this engagement begins at a limit.
      // Reaching a limit after an ordinary engagement keeps the dial narrow.
      dialContractionSuppressed = activeControlAtLimit;
    }
    if (panZoomMode === "gesture" && controlEngaged && !nextControlEngaged) {
      activeDialOriginX = moveEvent.clientX;
      activeDialOriginY = moveEvent.clientY;
      perpendicularOriginX = moveEvent.clientX;
      perpendicularOriginY = moveEvent.clientY;
      activeDialDeltaX = 0;
      activeDialDeltaY = 0;
    }
    if (panZoomMode === "gesture") {
      if (!gestureIndicator) {
        gestureIndicator = document.createElement("div");
        gestureIndicator.className = "gesture-direction-dial hidden";
        gestureIndicator.innerHTML = '<span class="dial-stage"><i class="dial-surface"></i><b class="dial-origin-dot"></b></span><em></em>';
        document.body.append(gestureIndicator);
      }
      const displayedGestureMode = nextGestureMode ?? gestureMode;
      gestureIndicator.classList.toggle("hidden", displayedGestureMode === null && !directionRearmed);
      gestureIndicator.classList.toggle("zooming", displayedGestureMode === "zoom");
      gestureIndicator.classList.toggle("panning", displayedGestureMode === "pan");
      gestureIndicator.classList.toggle("engaged", nextControlEngaged);
      gestureIndicator.classList.toggle("at-limit", activeControlAtLimit);
      gestureIndicator.classList.toggle("wall-left", nextControlEngaged && displayedGestureMode === "pan" && activeDialDeltaX < 0);
      gestureIndicator.classList.toggle("wall-right", nextControlEngaged && displayedGestureMode === "pan" && activeDialDeltaX >= 0);
      gestureIndicator.classList.toggle("wall-top", nextControlEngaged && displayedGestureMode === "zoom" && activeDialDeltaY < 0);
      gestureIndicator.classList.toggle("wall-bottom", nextControlEngaged && displayedGestureMode === "zoom" && activeDialDeltaY >= 0);
      const nearingSwitch = Boolean(gestureMode) && activeAxisDistance <= 38;
      gestureIndicator.classList.toggle("switching", nearingSwitch || directionRearmed);
      const originIntensity = Math.max(0.12, Math.min(1, 1 - originDistance / 260));
      gestureIndicator.style.setProperty("--origin-intensity", originIntensity.toFixed(2));
      const activeDotX = Math.max(-30, Math.min(30, displayedGestureMode === "zoom"
        ? moveEvent.clientX - perpendicularOriginX
        : activeDialDeltaX));
      const activeDotY = Math.max(-30, Math.min(30, displayedGestureMode === "pan"
        ? moveEvent.clientY - perpendicularOriginY
        : activeDialDeltaY));
      if (activeControlTravel <= 10) dotTracksPerpendicular = true;
      else if (
        activeControlTravel > 30
        && activeControlTravel < previousActiveControlTravel - 0.25
      ) dotTracksPerpendicular = false;
      previousActiveControlTravel = activeControlTravel;
      const activeDialThickness = activeControlTravel <= 30 || dialContractionSuppressed
        ? 70
        : 70 - 58 * Math.min(1, (activeControlTravel - 30) / 55);
      gestureIndicator.style.setProperty("--active-dial-thickness", `${activeDialThickness.toFixed(1)}px`);
      const perpendicularLimit = Math.max(0, activeDialThickness / 2 - 5);
      let dotX = activeDotX;
      let dotY = activeDotY;
      if (nextControlEngaged && displayedGestureMode === "zoom") {
        dotX = dotTracksPerpendicular
          ? Math.max(-perpendicularLimit, Math.min(perpendicularLimit, activeDotX))
          : 0;
      } else if (nextControlEngaged && displayedGestureMode === "pan") {
        dotY = dotTracksPerpendicular
          ? Math.max(-perpendicularLimit, Math.min(perpendicularLimit, activeDotY))
          : 0;
      }
      gestureIndicator.style.setProperty("--dot-x", `${dotX}px`);
      gestureIndicator.style.setProperty("--dot-y", `${dotY}px`);
      if (nextGestureMode === "pan") {
        gestureIndicator.style.setProperty("--pan-roll", `${visualPanRoll}px`);
      } else if (nextGestureMode === "zoom") {
        gestureIndicator.style.setProperty("--zoom-roll", `${visualZoomRoll}px`);
      }
      gestureIndicator.style.left = `${Math.max(8, Math.min(window.innerWidth - 104, moveEvent.clientX + 14))}px`;
      gestureIndicator.style.top = `${Math.max(8, Math.min(window.innerHeight - 104, moveEvent.clientY - 48))}px`;
    }
    if (nextGestureMode !== gestureMode && nextGestureMode === "zoom") {
      zoomAnchorElapsed = panDuringPlayback
        ? currentElapsed()
        : elapsedAtCenteredHead(tracks, tracks.clientWidth / 2);
      gestureOriginZoom = timelineZoom;
      gestureOriginY = moveEvent.clientY;
      timelinePanActive = false;
      timelineHeadLocked = true;
      tracks.classList.remove("head-unlocked", "playback-pan");
      centerArrangementOnElapsed(zoomAnchorElapsed);
    } else if (nextGestureMode !== gestureMode && nextGestureMode === "pan" && panDuringPlayback) {
      timelinePanActive = false;
      timelineHeadLocked = true;
      tracks.classList.remove("head-unlocked", "playback-pan");
      centerArrangementOnElapsed(currentElapsed());
    } else if (nextGestureMode !== gestureMode && nextGestureMode === null) {
      timelinePanActive = false;
      timelineHeadLocked = true;
      tracks.classList.remove("head-unlocked", "playback-pan");
      centerArrangementOnElapsed(panDuringPlayback ? currentElapsed() : pausedAt);
    }
    if (panZoomMode === "gesture" && nextControlEngaged !== controlEngaged) {
      if (nextControlEngaged && nextGestureMode === "zoom") {
        gestureOriginZoom = timelineZoom;
        gestureOriginY = moveEvent.clientY;
      } else if (panDuringPlayback && nextControlEngaged && nextGestureMode === "pan") {
        timelinePanActive = true;
        timelineHeadLocked = false;
        tracks.classList.add("head-unlocked");
      } else if (panDuringPlayback && !nextControlEngaged) {
        timelinePanActive = false;
        timelineHeadLocked = true;
        tracks.classList.remove("head-unlocked", "playback-pan");
        centerArrangementOnElapsed(currentElapsed());
      }
    }
    controlEngaged = nextControlEngaged;
    gestureMode = nextGestureMode;
    const panGestureActive = panZoomMode !== "gesture" || (gestureMode === "pan" && controlEngaged);
    tracks.classList.add("panning");
    tracks.classList.toggle("playback-pan", panDuringPlayback && panGestureActive);
    const pointerDeltaX = moveEvent.clientX - lastClientX;
    const pointerDeltaY = moveEvent.clientY - lastClientY;
    if (panGestureActive) {
      const previousScrollLeft = tracks.scrollLeft;
      tracks.scrollLeft = Math.max(
        panStartScrollLeft,
        Math.min(panEndScrollLeft, previousScrollLeft - pointerDeltaX)
      );
      const appliedPointerDelta = previousScrollLeft - tracks.scrollLeft;
      visualPanRoll += appliedPointerDelta * 0.8;
      gestureIndicator?.style.setProperty("--pan-roll", `${visualPanRoll}px`);
    }
    lastClientX = moveEvent.clientX;
    lastClientY = moveEvent.clientY;
    const ghostClientX = tracks.getBoundingClientRect().left + tracks.clientWidth / 2;
    const anchorElapsed = gestureMode === "zoom" ? zoomAnchorElapsed : elapsedAtTimelinePointer(tracks, ghostClientX);
    if (panZoomMode === "gesture" && gestureMode === "zoom" && controlEngaged) {
      const zoomRange = Math.max(1, gestureZoomBounds.max / Math.max(0.1, gestureZoomBounds.min));
      const verticalTravel = (gestureOriginY - moveEvent.clientY) / 240;
      const gestureZoom = gestureOriginZoom * Math.exp(Math.log(zoomRange) * verticalTravel);
      const nextZoom = clampTimelineZoom(gestureZoom, tracks);
      if (nextZoom !== timelineZoom) {
        visualZoomRoll += pointerDeltaY * 0.8;
        gestureIndicator?.style.setProperty("--zoom-roll", `${visualZoomRoll}px`);
        timelineZoom = nextZoom;
        preferredTimelineZoom = timelineZoom;
        applyTimelineZoomInPlace(tracks, zoomAnchorElapsed);
      }
    } else if (panZoomMode === "dynamic" && panDuringPlayback) {
      const previousZoom = timelineZoom;
      adaptTimelineZoomAtHead(tracks, anchorElapsed);
      if (timelineZoom !== previousZoom) keepTimelineElapsedUnderPointer(tracks, anchorElapsed, ghostClientX);
    }
    const gestureReadout = gestureIndicator?.querySelector("em");
    if (gestureReadout) {
      const limitLabel = Object.assign(document.createElement("span"), {
        className: "dial-limit-label",
        textContent: "Limit reached",
      });
      if (gestureMode === "zoom") {
        const scaleLabel = Object.assign(document.createElement("span"), { textContent: formatTimelineZoomLabel(timelineZoom, tracks) });
        gestureReadout.replaceChildren(scaleLabel, ...(activeControlAtLimit ? [limitLabel] : []));
      }
      else if (gestureMode === "pan") {
        const [timelineTime, sourceTime] = panningTimeLabels(anchorElapsed);
        gestureReadout.replaceChildren(
          Object.assign(document.createElement("span"), { textContent: timelineTime }),
          Object.assign(document.createElement("span"), { textContent: sourceTime }),
          ...(activeControlAtLimit ? [limitLabel] : [])
        );
      }
      else gestureReadout.textContent = "Zoom or Pan";
    }
    if (panDuringPlayback && panGestureActive) updatePanReleaseHead(tracks);
    if (panDuringPlayback) {
      updatePlayUi(currentElapsed());
    } else {
      pausedAt = elapsedAtCenteredHead(tracks, headViewportX);
      activePlaybackIndex = findSegmentIndex(pausedAt);
      if (panZoomMode !== "gesture") adaptTimelineZoomAtHead(tracks, pausedAt);
      seekTimelinePreviewThrottled(pausedAt);
      updatePlayUi(pausedAt);
    }
  };
  const end = () => {
    tracks.removeEventListener("pointermove", move);
    tracks.removeEventListener("pointerup", end);
    tracks.removeEventListener("pointercancel", end);
    tracks.classList.remove("panning", "playback-pan");
    gestureIndicator?.remove();
    timelinePanActive = false;
    timelineHeadLocked = previousHeadLocked;
    tracks.classList.toggle("head-unlocked", !timelineHeadLocked);
    if (!dragging) {
      return;
    }
    suppressNextTimelineSeek = true;
    window.setTimeout(() => { suppressNextTimelineSeek = false; }, 350);
    if (panDuringPlayback && playing) {
      if (panZoomMode === "gesture" && (gestureMode !== "pan" || !controlEngaged)) {
        updatePlayUi(currentElapsed());
        return;
      }
      const releaseElapsed = elapsedAtCenteredHead(tracks, tracks.clientWidth / 2);
      cancelAnimationFrame(animationFrame);
      playing = false;
      pausedAt = releaseElapsed;
      activePlaybackIndex = findSegmentIndex(pausedAt);
      updatePlayUi(pausedAt);
      cueArrangementAtPausedPosition(true);
    } else {
      cueArrangementAtPausedPosition(false);
    }
  };
  tracks.addEventListener("pointermove", move);
  tracks.addEventListener("pointerup", end);
  tracks.addEventListener("pointercancel", end);
}

function elapsedAtTimelinePointer(tracks: HTMLElement, clientX: number) {
  const viewportX = clientX - tracks.getBoundingClientRect().left;
  const position = Math.max(0, tracks.scrollLeft + viewportX - timelineContentOrigin(tracks));
  return Math.min(totalDuration(project.segments), timelineElapsedAtPosition(position));
}

function keepTimelineElapsedUnderPointer(tracks: HTMLElement, elapsed: number, clientX: number) {
  const viewportX = clientX - tracks.getBoundingClientRect().left;
  tracks.scrollLeft = Math.max(0, timelineContentOrigin(tracks) + timelinePosition(elapsed) - viewportX);
  arrangementScrollLeft = tracks.scrollLeft;
}

function updatePanReleaseHead(tracks: HTMLElement) {
  tracks.style.setProperty("--pan-release-x", `${tracks.scrollLeft + tracks.clientWidth / 2}px`);
}

function elapsedAtCenteredHead(tracks: HTMLElement, headViewportX = timelineHeadViewportX(tracks)) {
  const position = Math.max(0, tracks.scrollLeft + headViewportX - timelineContentOrigin(tracks));
  return Math.min(totalDuration(project.segments), timelineElapsedAtPosition(position));
}

function cueArrangementAtPausedPosition(resumePlayback: boolean) {
  const segment = project.segments[activePlaybackIndex];
  const source = segment && sourceForSegment(segment);
  if (!segment || !source || !youtubePlayer || !playerReady) return;
  const offset = Math.max(0, pausedAt - segmentStart(activePlaybackIndex));
  const options = { videoId: source.videoId, startSeconds: segment.sourceStartSeconds + offset, endSeconds: playbackEndSeconds(activePlaybackIndex) };
  bufferedArrangementSegmentId = segment.id;
  if (resumePlayback) {
    arrangementPlaybackTransitioning = true;
    playing = true;
    playStartedAt = performance.now();
    pauseWhenFrameAvailable = false;
    loadedVideoId = source.videoId;
    youtubePlayer.loadVideoById(options);
    updatePlaybackButtons();
    tick();
  } else {
    if (!frameBufferingEnabled) {
      pauseWhenFrameAvailable = false;
      loadedVideoId = source.videoId;
      loadedVideoHasFrame = false;
      youtubePlayer.cueVideoById(options);
    } else if (loadedVideoId === source.videoId && loadedVideoHasFrame) {
      youtubePlayer.seekTo(options.startSeconds, true);
      youtubePlayer.pauseVideo();
    } else {
      loadedVideoId = source.videoId;
      loadedVideoHasFrame = false;
      pauseWhenFrameAvailable = true;
      youtubePlayer.loadVideoById(options);
    }
    setPlaybackStatus(`Positioning preview at ${formatTime(pausedAt)}…`);
  }
}

function seekTimelinePreviewThrottled(elapsed: number) {
  const now = performance.now();
  if (now - lastTimelinePanSeekAt < 1000 || !youtubePlayer || !playerReady) return;
  const index = findSegmentIndex(elapsed);
  const segment = project.segments[index];
  const source = segment && sourceForSegment(segment);
  if (!segment || !source) return;
  lastTimelinePanSeekAt = now;
  const sourceTimestamp = segment.sourceStartSeconds + Math.max(0, elapsed - segmentStart(index));
  const options = { videoId: source.videoId, startSeconds: sourceTimestamp, endSeconds: playbackEndSeconds(index) };
  bufferedArrangementSegmentId = segment.id;
  if (!frameBufferingEnabled) {
    pauseWhenFrameAvailable = false;
    loadedVideoId = source.videoId;
    loadedVideoHasFrame = false;
    youtubePlayer.cueVideoById(options);
  } else if (loadedVideoId !== source.videoId || !loadedVideoHasFrame) {
    loadedVideoId = source.videoId;
    loadedVideoHasFrame = false;
    pauseWhenFrameAvailable = true;
    youtubePlayer.loadVideoById(options);
  } else {
    youtubePlayer.seekTo(sourceTimestamp, true);
    youtubePlayer.pauseVideo();
  }
  setPlaybackStatus(`Preview positioned at ${formatTime(elapsed)}`);
}

function bindTimelineEvents(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => button.addEventListener("click", () => editSegment(button.dataset.action!, button.dataset.id!)));
  root.querySelectorAll<HTMLButtonElement>("[data-trim]").forEach((handle) => handle.addEventListener("pointerdown", beginTrim));
  root.querySelectorAll<HTMLElement>(".segment[data-segment]").forEach((item) => {
    item.addEventListener("pointerdown", beginSegmentReorder);
    item.addEventListener("click", selectMoment);
  });
  root.querySelector<HTMLElement>(".source-tracks")?.addEventListener("pointerdown", beginMarqueeSelection);
  root.querySelectorAll<HTMLElement>("[data-bulk-action]").forEach((button) => button.addEventListener("click", () => bulkEditMoments(button.dataset.bulkAction!)));
}

function selectMoment(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("button")) return;
  const card = event.currentTarget as HTMLElement;
  if (suppressNextMomentClick) {
    suppressNextMomentClick = false;
    return;
  }
  if (card.dataset.dragged === "true") {
    delete card.dataset.dragged;
    return;
  }
  const id = card.dataset.segment;
  if (!id) return;
  const segment = project.segments.find((item) => item.id === id);
  if (!event.shiftKey) {
    selectedMomentIds.clear();
    if (segment?.groupId) project.segments.filter((item) => item.groupId === segment.groupId).forEach((item) => selectedMomentIds.add(item.id));
    else selectedMomentIds.add(id);
  } else if (selectedMomentIds.has(id)) selectedMomentIds.delete(id);
  else selectedMomentIds.add(id);
  refreshTimeline(false);
}

function beginMarqueeSelection(event: PointerEvent) {
  if (event.button !== 0 || !event.shiftKey) return;
  const target = event.target as HTMLElement;
  const startedOnSegment = Boolean(target.closest(".segment"));
  if ((!event.shiftKey && startedOnSegment) || target.closest("button, .track-label, .time-label, .time-axis, .trim-handle, .arrangement-head") || !target.closest(".source-tracks")) return;

  event.preventDefault();
  const tracks = event.currentTarget as HTMLElement;
  const originX = event.clientX;
  const originY = event.clientY;
  const selectionBeforeDrag = event.shiftKey ? new Set(selectedMomentIds) : new Set<string>();
  const marquee = document.createElement("div");
  marquee.className = "selection-marquee";
  let dragging = false;
  tracks.setPointerCapture(event.pointerId);

  const move = (moveEvent: PointerEvent) => {
    if (!dragging && Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) < 5) return;
    if (!dragging) {
      dragging = true;
      document.body.append(marquee);
    }
    const left = Math.min(originX, moveEvent.clientX);
    const top = Math.min(originY, moveEvent.clientY);
    const right = Math.max(originX, moveEvent.clientX);
    const bottom = Math.max(originY, moveEvent.clientY);
    marquee.style.left = `${left}px`;
    marquee.style.top = `${top}px`;
    marquee.style.width = `${right - left}px`;
    marquee.style.height = `${bottom - top}px`;

    selectedMomentIds.clear();
    selectionBeforeDrag.forEach((id) => selectedMomentIds.add(id));
    const touchedIndexes = new Set<number>();
    tracks.querySelectorAll<HTMLElement>(".segment[data-segment]").forEach((card) => {
      const bounds = card.getBoundingClientRect();
      if (bounds.left <= right && bounds.right >= left) touchedIndexes.add(Number(card.dataset.index));
    });
    if (touchedIndexes.size) {
      const first = Math.min(...touchedIndexes);
      const last = Math.max(...touchedIndexes);
      project.segments.slice(first, last + 1).forEach((segment) => selectedMomentIds.add(segment.id));
    }
    tracks.querySelectorAll<HTMLElement>(".segment[data-segment]").forEach((card) => {
      card.classList.toggle("selected", Boolean(card.dataset.segment && selectedMomentIds.has(card.dataset.segment)));
    });
  };

  const finish = (cancelled = false) => {
    tracks.removeEventListener("pointermove", move);
    tracks.removeEventListener("pointerup", end);
    tracks.removeEventListener("pointercancel", cancel);
    marquee.remove();
    if (cancelled) {
      selectedMomentIds.clear();
      selectionBeforeDrag.forEach((id) => selectedMomentIds.add(id));
    }
    if (dragging) {
      suppressNextMomentClick = true;
      suppressNextTimelineSeek = true;
      window.setTimeout(() => { suppressNextMomentClick = false; }, 0);
      window.setTimeout(() => { suppressNextTimelineSeek = false; }, 0);
      refreshTimeline(false);
    }
  };
  const end = () => finish();
  const cancel = () => finish(true);
  tracks.addEventListener("pointermove", move);
  tracks.addEventListener("pointerup", end);
  tracks.addEventListener("pointercancel", cancel);
}

function bulkEditMoments(action: string) {
  if (action === "group" && selectedMomentIds.size > 1) selectContiguousMomentRange();
  const selected = project.segments.filter((segment) => selectedMomentIds.has(segment.id));
  if (!selected.length) return;
  if (action === "delete") {
    project.segments = project.segments.filter((segment) => !selectedMomentIds.has(segment.id));
    selectedMomentIds.clear();
  }
  if (action === "duplicate") {
    const lastIndex = Math.max(...selected.map((segment) => project.segments.indexOf(segment)));
    const sharedGroup = selected[0].groupId && selected.every((segment) => segment.groupId === selected[0].groupId);
    const duplicateGroup = sharedGroup ? crypto.randomUUID() : undefined;
    const copies = selected.map((segment) => ({ ...segment, id: crypto.randomUUID(), groupId: duplicateGroup }));
    project.segments.splice(lastIndex + 1, 0, ...copies);
    lastAddedMomentId = copies.at(-1)?.id ?? null;
    selectedMomentIds.clear();
    copies.forEach((segment) => selectedMomentIds.add(segment.id));
  }
  if (action === "group" && selected.length > 1) {
    const groupId = crypto.randomUUID();
    selected.forEach((segment) => { segment.groupId = groupId; });
  }
  if (action === "ungroup") selected.forEach((segment) => { delete segment.groupId; });
  cleanupMomentGroups();
  saveProject();
  refreshTimeline(action === "duplicate");
}

function selectContiguousMomentRange() {
  const indexes = project.segments.flatMap((segment, index) => selectedMomentIds.has(segment.id) ? [index] : []);
  if (!indexes.length) return;
  project.segments.slice(Math.min(...indexes), Math.max(...indexes) + 1).forEach((segment) => selectedMomentIds.add(segment.id));
}

function cleanupMomentGroups() {
  const counts = new Map<string, number>();
  project.segments.forEach((segment) => { if (segment.groupId) counts.set(segment.groupId, (counts.get(segment.groupId) ?? 0) + 1); });
  project.segments.forEach((segment) => { if (segment.groupId && (counts.get(segment.groupId) ?? 0) < 2) delete segment.groupId; });
}

function selectSlot(slot: number) {
  if (mode === "mix" && captureSlot !== null) {
    finishLiveCapture();
    youtubePlayer?.pauseVideo();
  }
  selectedSlot = slot;
  message = "";
  if (mode === "browse") editingSlot = slot;
  render();
}

function editTrack(slot: number) {
  if (!sourceForSlot(slot)) return;
  if (captureSlot !== null) finishLiveCapture();
  playing = false;
  cancelAnimationFrame(animationFrame);
  youtubePlayer?.pauseVideo();
  selectedSlot = slot;
  editingSlot = slot;
  mode = "browse";
  message = "";
  render();
}

function deleteTrack(slot: number) {
  const source = sourceForSlot(slot);
  if (!source) return;
  const segmentCount = project.segments.filter((segment) => segment.sourceId === source.id).length;
  const warning = segmentCount
    ? `Delete source ${slot}, “${source.title}”? This will also permanently remove ${segmentCount} timeline moment${segmentCount === 1 ? "" : "s"} that use it.`
    : `Delete source ${slot}, “${source.title}”? This cannot be undone after the page is closed.`;
  if (!window.confirm(warning)) return;
  if (captureSlot !== null) finishLiveCapture();
  playing = false;
  cancelAnimationFrame(animationFrame);
  youtubePlayer?.pauseVideo();
  project.sources = project.sources.filter((item) => item.id !== source.id);
  project.segments = project.segments.filter((segment) => segment.sourceId !== source.id);
  cleanupMomentGroups();
  selectedMomentIds.clear();
  selectedSlot = project.sources[0]?.slot ?? 1;
  pausedAt = Math.min(pausedAt, totalDuration(project.segments));
  activePlaybackIndex = project.segments.length ? findSegmentIndex(pausedAt) : -1;
  saveProject();
  render();
}

function assignSource(event: SubmitEvent) {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const url = String(form.get("url") ?? "");
  const videoId = parseYouTubeId(url);
  if (!videoId || editingSlot === null) {
    message = "That doesn’t look like a valid YouTube link or 11-character video ID.";
    render();
    return;
  }
  const existing = sourceForSlot(editingSlot);
  const source: Source = { id: existing?.id ?? crypto.randomUUID(), slot: editingSlot, videoId, originalUrl: url.trim(), title: String(form.get("title") ?? "").trim() || `YouTube video ${videoId}` };
  project.sources = [...project.sources.filter((item) => item.slot !== editingSlot), source];
  saveProject();
  selectedSlot = editingSlot;
  editingSlot = null;
  message = "";
  render();
}

function updateTimeValues() {
  const startInput = document.querySelector<HTMLInputElement>("#start-time");
  const endInput = document.querySelector<HTMLInputElement>("#end-time");
  if (!startInput || !endInput) {
    updateSegmentDefinitionRuler();
    return;
  }
  const nextStart = Number(startInput.value);
  const nextEnd = Number(endInput.value);
  if (nextStart !== startValue) {
    const preservedDuration = Math.max(0.1, endValue - startValue);
    startValue = Math.max(0, nextStart);
    endValue = startValue + preservedDuration;
    const endInput = document.querySelector<HTMLInputElement>("#end-time");
    if (endInput) endInput.value = String(Number(endValue.toFixed(1)));
  } else {
    endValue = nextEnd;
  }
  const readout = document.querySelector<HTMLElement>(".duration-readout b");
  if (readout) readout.textContent = formatTime(endValue - startValue);
  updateSegmentDefinitionRuler();
}

function addSegment() {
  updateTimeValues();
  const source = sourceForSlot(selectedSlot);
  if (!source) return;
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue < 0 || endValue <= startValue) {
    message = "Start must be zero or later, and end must be after start.";
    render();
    return;
  }
  const insertionIndex = insertionIndexAtHead();
  const insertedDuration = endValue - startValue;
  const insertedId = crypto.randomUUID();
  project.segments.splice(insertionIndex, 0, { id: insertedId, sourceId: source.id, sourceStartSeconds: startValue, sourceEndSeconds: endValue, lane: 0 });
  lastAddedMomentId = insertedId;
  pausedAt = segmentStart(insertionIndex) + insertedDuration;
  activePlaybackIndex = findSegmentIndex(pausedAt);
  saveProject();
  message = "";
  refreshTimeline(false);
  requestAnimationFrame(centerArrangementOnHead);
}

function insertionIndexAtHead() {
  if (!project.segments.length) return 0;
  if (pausedAt <= 0) return 0;
  let boundary = 0;
  for (let index = 0; index < project.segments.length; index += 1) {
    boundary += segmentDuration(project.segments[index]);
    // At an exact boundary, insert after the segment that ends there. The
    // playback lookup assigns that same instant to the following segment,
    // which would otherwise skip one position when another clip is captured.
    if (pausedAt <= boundary + 0.001) return index + 1;
  }
  return project.segments.length;
}

function editSegment(action: string, id: string) {
  const index = project.segments.findIndex((segment) => segment.id === id);
  if (index < 0) return;
  if (action === "delete") {
    project.segments.splice(index, 1);
    selectedMomentIds.delete(id);
  }
  if (action === "duplicate") {
    const copy = { ...project.segments[index], id: crypto.randomUUID() };
    project.segments.splice(index + 1, 0, copy);
    lastAddedMomentId = copy.id;
  }
  cleanupMomentGroups();
  saveProject();
  render();
}

function reorderSegment(fromId: string, toId: string, draggedIds?: Set<string>, placeAfter = false) {
  const fromSegment = project.segments.find((segment) => segment.id === fromId);
  if (!fromSegment || !project.segments.some((segment) => segment.id === toId)) return;
  const moving = draggedIds
    ? project.segments.filter((segment) => draggedIds.has(segment.id))
    : fromSegment.groupId ? project.segments.filter((segment) => segment.groupId === fromSegment.groupId) : [fromSegment];
  if (moving.some((segment) => segment.id === toId)) return;
  const movingIds = new Set(moving.map((segment) => segment.id));
  const remaining = project.segments.filter((segment) => !movingIds.has(segment.id));
  const targetIndex = remaining.findIndex((segment) => segment.id === toId);
  const insertionIndex = targetIndex < 0 ? remaining.length : targetIndex + (placeAfter ? 1 : 0);
  remaining.splice(insertionIndex, 0, ...moving);
  project.segments = remaining;
  saveProject();
  if (mode === "mix") refreshTimeline(false);
  else render();
}

function beginSegmentReorder(event: PointerEvent) {
  if (event.shiftKey || project.segments.length < 2) return;
  const card = event.currentTarget as HTMLElement;
  if ((event.target as HTMLElement).closest("button")) return;
  const fromId = card.dataset.segment;
  if (!fromId) return;
  const fromSegment = project.segments.find((segment) => segment.id === fromId);
  const movingIds = selectedMomentIds.has(fromId) && selectedMomentIds.size > 1
    ? new Set(selectedMomentIds)
    : new Set(fromSegment?.groupId
      ? project.segments.filter((segment) => segment.groupId === fromSegment.groupId).map((segment) => segment.id)
      : [fromId]);
  const movingCards = [...document.querySelectorAll<HTMLElement>(".segment[data-segment]")]
    .filter((item) => Boolean(item.dataset.segment && movingIds.has(item.dataset.segment)));
  const tracks = card.closest<HTMLElement>(".source-tracks");
  const originX = event.clientX;
  const originY = event.clientY;
  const cardBounds = card.getBoundingClientRect();
  const grabOffsetX = originX - cardBounds.left;
  const grabOffsetY = originY - cardBounds.top;
  let appliedDeltaX = 0;
  let appliedDeltaY = 0;
  let pointerX = event.clientX;
  let pointerY = event.clientY;
  let edgePanFrame = 0;
  let dragging = false;
  let dropTarget: HTMLElement | null = null;
  let dropColumn: HTMLElement[] = [];
  let placeAfter = false;
  card.setPointerCapture(event.pointerId);
  const updateDraggedCards = () => {
    const transformedBounds = card.getBoundingClientRect();
    const untransformedLeft = transformedBounds.left - appliedDeltaX;
    const untransformedTop = transformedBounds.top - appliedDeltaY;
    const deltaX = pointerX - grabOffsetX - untransformedLeft;
    const deltaY = pointerY - grabOffsetY - untransformedTop;
    movingCards.forEach((item) => { item.style.transform = `translate3d(${deltaX}px,${deltaY}px,0)`; });
    appliedDeltaX = deltaX;
    appliedDeltaY = deltaY;
    dropTarget?.classList.remove("drop-target");
    dropColumn.forEach((item) => item.classList.remove("drop-column", "drop-after"));
    const targets = [...document.querySelectorAll<HTMLElement>(".segment[data-segment]")]
      .filter((item) => Boolean(item.dataset.segment && !movingIds.has(item.dataset.segment)));
    dropTarget = targets.sort((a, b) => {
      const aBounds = a.getBoundingClientRect();
      const bBounds = b.getBoundingClientRect();
      return Math.abs(pointerX - (aBounds.left + aBounds.width / 2))
        - Math.abs(pointerX - (bBounds.left + bBounds.width / 2));
    })[0] ?? null;
    if (!dropTarget) return;
    placeAfter = pointerX > dropTarget.getBoundingClientRect().left + dropTarget.getBoundingClientRect().width / 2;
    dropTarget.classList.add("drop-target");
    dropTarget.classList.toggle("drop-after", placeAfter);
    dropColumn = [...document.querySelectorAll<HTMLElement>(`[data-index="${dropTarget.dataset.index}"]`)]
      .filter((item) => !item.classList.contains("dragging"));
    dropColumn.forEach((item) => {
      item.classList.add("drop-column");
      item.classList.toggle("drop-after", placeAfter);
    });
  };
  const edgePan = () => {
    if (!dragging || !tracks) return;
    const bounds = tracks.getBoundingClientRect();
    const edgeSize = Math.min(100, Math.max(48, bounds.width * 0.12));
    const leftDepth = Math.max(0, Math.min(1, (bounds.left + edgeSize - pointerX) / edgeSize));
    const rightDepth = Math.max(0, Math.min(1, (pointerX - (bounds.right - edgeSize)) / edgeSize));
    const panSpeed = (rightDepth * rightDepth - leftDepth * leftDepth) * 22;
    if (Math.abs(panSpeed) > 0.1) {
      const previousScroll = tracks.scrollLeft;
      tracks.scrollLeft += panSpeed;
      if (tracks.scrollLeft !== previousScroll) {
        pausedAt = elapsedAtCenteredHead(tracks);
        activePlaybackIndex = findSegmentIndex(pausedAt);
        adaptTimelineZoomAtHead(tracks, pausedAt);
        updatePlayUi(pausedAt);
        updateDraggedCards();
      }
    }
    edgePanFrame = requestAnimationFrame(edgePan);
  };
  const move = (moveEvent: PointerEvent) => {
    pointerX = moveEvent.clientX;
    pointerY = moveEvent.clientY;
    if (!dragging && Math.hypot(pointerX - originX, pointerY - originY) > 6) {
      dragging = true;
      card.dataset.dragged = "true";
      timelineHeadLocked = false;
      tracks?.classList.add("head-unlocked");
      movingCards.forEach((item) => item.classList.add("dragging"));
      edgePanFrame = requestAnimationFrame(edgePan);
    }
    if (!dragging) return;
    updateDraggedCards();
  };
  const end = () => {
    cancelAnimationFrame(edgePanFrame);
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerup", end);
    card.removeEventListener("pointercancel", cancel);
    movingCards.forEach((item) => { item.classList.remove("dragging"); item.style.removeProperty("transform"); });
    dropTarget?.classList.remove("drop-target", "drop-after");
    dropColumn.forEach((item) => item.classList.remove("drop-column", "drop-after"));
    if (!dragging) return;
    suppressNextTimelineSeek = true;
    window.setTimeout(() => { suppressNextTimelineSeek = false; }, 0);
    if (dropTarget?.dataset.segment) reorderSegment(fromId, dropTarget.dataset.segment, movingIds, placeAfter);
  };
  const cancel = () => {
    cancelAnimationFrame(edgePanFrame);
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerup", end);
    card.removeEventListener("pointercancel", cancel);
    movingCards.forEach((item) => { item.classList.remove("dragging"); item.style.removeProperty("transform"); });
    dropTarget?.classList.remove("drop-target", "drop-after");
    dropColumn.forEach((item) => item.classList.remove("drop-column", "drop-after"));
  };
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", cancel);
}

function beginTrim(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLButtonElement;
  const segment = project.segments.find((item) => item.id === handle.dataset.id);
  const edge = handle.dataset.trim as "start" | "end";
  if (!segment) return;
  const originX = event.clientX;
  const originalStart = segment.sourceStartSeconds;
  const originalEnd = segment.sourceEndSeconds;
  const trimPixelsPerSecond = Math.max(0.1, timelineZoom);
  const card = handle.closest<HTMLElement>(".segment");
  card?.classList.add("trimming");
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    const deltaSeconds = (moveEvent.clientX - originX) / trimPixelsPerSecond;
    if (edge === "start") segment.sourceStartSeconds = Number(Math.max(0, Math.min(originalEnd - 0.1, originalStart + deltaSeconds)).toFixed(2));
    else segment.sourceEndSeconds = Number(Math.max(originalStart + 0.1, originalEnd + deltaSeconds).toFixed(2));
    updateSegmentBar(card, segment);
    updateTrimPreview(card, edge, moveEvent.clientX - originX);
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    card?.classList.remove("trimming");
    saveProject();
    render();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function updateTrimPreview(card: HTMLElement | null, edge: "start" | "end", pointerDelta: number) {
  if (!card) return;
  const cropTrack = card.querySelector<HTMLElement>(".duration-bar>span");
  const maximumCrop = cropTrack?.clientWidth ?? card.clientWidth;
  const cropDistance = edge === "start" ? pointerDelta : -pointerDelta;
  const cropPixels = Math.min(maximumCrop, Math.max(0, cropDistance));
  card.style.setProperty("--trim-start-crop", edge === "start" ? `${cropPixels}px` : "0px");
  card.style.setProperty("--trim-end-crop", edge === "end" ? `${cropPixels}px` : "0px");
}

function updateSegmentBar(card: HTMLElement | null, segment: Segment) {
  if (!card) return;
  const duration = segmentDuration(segment);
  card.style.setProperty("--segment-width", `${Math.min(520, Math.max(190, duration * 18))}px`);
  const segmentLabel = card.querySelector<HTMLElement>(".segment-label");
  if (segmentLabel) {
    segmentLabel.textContent = `${formatTime(segment.sourceStartSeconds)} · ${duration.toFixed(1)}s`;
    segmentLabel.title = `YouTube start ${formatTime(segment.sourceStartSeconds)} · length ${duration.toFixed(1)} seconds`;
  }
  const label = card.querySelector(".duration-bar em");
  if (label) label.textContent = `${duration.toFixed(1)}s`;
}

function segmentStart(index: number) {
  return project.segments.slice(0, index).reduce((sum, segment) => sum + segmentDuration(segment), 0);
}

function segmentsPlayContinuously(previousIndex: number, nextIndex: number) {
  const previous = project.segments[previousIndex];
  const next = project.segments[nextIndex];
  return Boolean(
    previous
    && next
    && segmentsUseSameVideo(previousIndex, nextIndex)
    && Math.abs(previous.sourceEndSeconds - next.sourceStartSeconds) <= CONTIGUOUS_SOURCE_EPSILON_SECONDS
  );
}

function segmentsUseSameVideo(previousIndex: number, nextIndex: number) {
  const previous = project.segments[previousIndex];
  const next = project.segments[nextIndex];
  const previousSource = previous && sourceForSegment(previous);
  const nextSource = next && sourceForSegment(next);
  return Boolean(previousSource && nextSource && previousSource.videoId === nextSource.videoId);
}

function playbackEndSeconds(startIndex: number) {
  const segment = project.segments[startIndex];
  // Let the arrangement clock pause the final frame. Supplying endSeconds for
  // the last clip makes YouTube enter its ended state and show its play overlay.
  if (!segment || startIndex === project.segments.length - 1 || segmentsUseSameVideo(startIndex, startIndex + 1)) return undefined;
  return segment.sourceEndSeconds;
}

function activeSegmentAt(elapsed: number) {
  let cursor = 0;
  for (const segment of project.segments) {
    cursor += segmentDuration(segment);
    if (elapsed < cursor) return segment;
  }
  return undefined;
}

function currentElapsed() {
  return playing ? Math.min(totalDuration(project.segments), pausedAt + (performance.now() - playStartedAt) / 1000) : pausedAt;
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("YouTube player took too long to load.")), 15000);
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("YouTube player could not be loaded."));
    };
    document.head.append(script);
  });
  return youtubeApiPromise;
}

async function mountPlayerForCurrentView() {
  const host = document.querySelector("#youtube-player");
  if (!host) return;
  const source = mode === "mix" ? sourceForSlot(selectedSlot) : sourceForSegment(project.segments[Math.max(0, activePlaybackIndex)] ?? project.segments[0]);
  if (!source) return;
  const generation = ++playerGeneration;
  playerReady = false;
  sourceVideoPlaying = false;
  activeVideoDuration = 0;
  try {
    youtubePlayer?.destroy();
  } catch { /* The preceding render may already have removed its iframe. */ }
  youtubePlayer = null;
  loadedVideoId = null;
  loadedVideoHasFrame = false;
  bufferedArrangementSegmentId = null;
  pauseWhenFrameAvailable = false;
  setPlaybackStatus("Loading YouTube player…");
  try {
    await loadYouTubeApi();
    if (generation !== playerGeneration || !document.querySelector("#youtube-player")) return;
    youtubePlayer = new window.YT!.Player("youtube-player", {
      width: "100%",
      height: "100%",
      videoId: source.videoId,
      // The standard embed can use a browser's existing YouTube session when
      // YouTube cookies are available, allowing YouTube to apply Premium benefits.
      // Login and membership state remain private inside the cross-origin iframe.
      host: "https://www.youtube.com",
      playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, origin: window.location.origin },
      events: {
        onReady: () => {
          if (generation !== playerGeneration) return;
          playerReady = true;
          activeVideoDuration = Math.max(0, youtubePlayer?.getDuration() ?? 0);
          updateSegmentDefinitionRuler();
          setPlaybackStatus(mode === "play" ? "Ready · sound on" : "Ready to preview with sound");
          updateGuidedVideoActions();
          if (mode === "play" && playing) {
            playStartedAt = performance.now();
            playActiveSegment();
            animationFrame = requestAnimationFrame(tick);
          }
          if (mode === "mix" && pendingCaptureSlot === selectedSlot) {
            const slot = pendingCaptureSlot;
            pendingCaptureSlot = null;
            beginLiveCapture(slot);
          }
        },
        onStateChange: (event: { data: number }) => {
          activeVideoDuration = Math.max(activeVideoDuration, youtubePlayer?.getDuration() ?? 0);
          updateSegmentDefinitionRuler();
          if (event.data === 3) setPlaybackStatus("Buffering…");
          if (event.data === 1) {
            loadedVideoHasFrame = true;
            if (pauseWhenFrameAvailable) {
              pauseWhenFrameAvailable = false;
              youtubePlayer?.pauseVideo();
              sourceVideoPlaying = false;
              setPlaybackStatus(`Preview positioned at ${formatTime(pausedAt)}`);
              restoreMixKeyboardFocus();
              return;
            }
            arrangementPlaybackTransitioning = false;
            sourceVideoPlaying = true;
            if (previewStopAtEnd !== null) monitorPreviewEnd();
            setPlaybackStatus(captureSlot === null ? "Playing with sound" : `Recording source ${captureSlot}`);
          }
          if (event.data === 0 || event.data === 2) {
            sourceVideoPlaying = false;
            cancelAnimationFrame(previewEndFrame);
            if (event.data === 2) {
              const changingArrangementSegment = playing && arrangementPlaybackTransitioning;
              if (playing && !changingArrangementSegment) pauseTimelineFromVideoPlayer();
              if (!changingArrangementSegment) setPlaybackStatus("Paused");
            }
          }
          updateGuidedVideoActions();
          restoreMixKeyboardFocus();
        },
        onError: (event: { data: number }) => {
          arrangementPlaybackTransitioning = false;
          playing = false;
          cancelAnimationFrame(animationFrame);
          setPlaybackStatus(`This video cannot be played here (error ${event.data}).`);
        },
      },
    });
    loadedVideoId = source.videoId;
  } catch (error) {
    setPlaybackStatus(error instanceof Error ? error.message : "YouTube player could not be loaded.");
  }
}

function setPlaybackStatus(status: string) {
  const element = document.querySelector<HTMLElement>(".playback-status, .mix-playback-status");
  if (element) element.textContent = status;
}

function previewSegment() {
  updateTimeValues();
  const source = sourceForSlot(selectedSlot);
  if (!source || !youtubePlayer || !playerReady) {
    message = "The YouTube player is still loading. Try again in a moment.";
    render();
    return;
  }
  if (startValue < 0 || endValue <= startValue) {
    message = "Start must be zero or later, and end must be after start.";
    render();
    return;
  }
  message = "";
  pauseWhenFrameAvailable = false;
  bufferedArrangementSegmentId = null;
  loadedVideoId = source.videoId;
  previewStopAtEnd = endValue;
  youtubePlayer.loadVideoById({ videoId: source.videoId, startSeconds: startValue });
  setPlaybackStatus("Playing clip with sound");
}

function monitorPreviewEnd() {
  cancelAnimationFrame(previewEndFrame);
  const update = () => {
    if (!youtubePlayer || previewStopAtEnd === null || !sourceVideoPlaying) return;
    if (youtubePlayer.getCurrentTime() >= previewStopAtEnd) {
      previewStopAtEnd = null;
      youtubePlayer.pauseVideo();
      setPlaybackStatus("Clip preview complete");
      return;
    }
    previewEndFrame = requestAnimationFrame(update);
  };
  previewEndFrame = requestAnimationFrame(update);
}

function setBoundFromPlayer(bound: "start" | "end") {
  if (!youtubePlayer || !playerReady) return;
  const time = Math.max(0, Number(youtubePlayer.getCurrentTime().toFixed(1)));
  if (bound === "start") {
    const preservedDuration = Math.max(0.1, endValue - startValue);
    startValue = time;
    endValue = time + preservedDuration;
  }
  else {
    endValue = time;
    previewStopAtEnd = null;
    cancelAnimationFrame(previewEndFrame);
    youtubePlayer.pauseVideo();
  }
  const startInput = document.querySelector<HTMLInputElement>("#start-time");
  const endInput = document.querySelector<HTMLInputElement>("#end-time");
  if (startInput) startInput.value = startValue.toFixed(1);
  if (endInput) endInput.value = endValue.toFixed(1);
  const readout = document.querySelector<HTMLElement>(".duration-readout b");
  if (readout) readout.textContent = formatTime(Math.max(0, endValue - startValue));
  updateSegmentDefinitionRuler();
}

function finishLiveCapture(sourceEnd = youtubePlayer?.getCurrentTime()) {
  if (captureSlot === null) return;
  cancelAnimationFrame(segmentDefinitionFrame);
  const end = Number(sourceEnd);
  const insertionIndex = project.segments.findIndex((segment) => segment.id === captureSegmentId);
  if (insertionIndex >= 0 && Number.isFinite(end) && end > captureSourceStart) {
    const segment = project.segments[insertionIndex];
    segment.sourceEndSeconds = Number(end.toFixed(1));
    const insertedDuration = segmentDuration(segment);
    lastAddedMomentId = segment.id;
    pausedAt = segmentStart(insertionIndex) + insertedDuration;
    activePlaybackIndex = insertionIndex;
    saveProject();
    updateCaptureTimeline();
    finalizeCapturedTimelineSegment(segment);
  } else if (insertionIndex >= 0) {
    project.segments.splice(insertionIndex, 1);
    refreshTimeline(false);
  }
  captureSegmentId = null;
  captureSlot = null;
  updateGuidedVideoActions();
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (tracks && panZoomMode === "dynamic") adaptTimelineZoomAtHead(tracks, pausedAt);
}

function finalizeCapturedTimelineSegment(segment: Segment) {
  const card = document.querySelector<HTMLElement>(`.segment[data-segment="${segment.id}"]`);
  card?.classList.remove("capturing");
  const widths = timelineColumnWidths();
  const axis = document.querySelector<HTMLElement>(".time-axis");
  if (axis) axis.innerHTML = timeAxisLabels(widths);
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (tracks) {
    tracks.querySelectorAll(".group-region").forEach((region) => region.remove());
    tracks.insertAdjacentHTML("beforeend", groupRegions(widths));
  }
  updateArrangementSummary();
}

function updateArrangementSummary() {
  const summary = document.querySelector<HTMLElement>("#arrangement-summary-title");
  if (!summary) return;
  summary.textContent = project.segments.length
    ? `${project.segments.length} moments · ${formatTime(totalDuration(project.segments))}`
    : "Your mix is empty";
}

function refreshTimeline(scrollToEnd = false) {
  if (mode !== "mix") return;
  const current = document.querySelector<HTMLElement>(".timeline-section");
  if (!current) return;
  timelineZoom = clampTimelineZoom(timelineZoom, current.querySelector<HTMLElement>(".source-tracks"));
  current.outerHTML = timelineView();
  const next = document.querySelector<HTMLElement>(".timeline-section");
  if (!next) return;
  const tracks = next.querySelector<HTMLElement>(".source-tracks");
  if (tracks) syncTimelineGutters(tracks);
  next.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode as Mode)));
  next.querySelectorAll<HTMLElement>("[data-slot]").forEach((button) => button.addEventListener("click", () => selectSlot(Number(button.dataset.slot))));
  bindTimelineEvents(next);
  bindTimelineControls(next);
  refreshRightTimelineToolbar();
  updateMixPrimaryAction();
  updateMixFocusToggle();
  updateArrangementSummary();
  if (scrollToEnd) requestAnimationFrame(scrollArrangementToEnd);
  else requestAnimationFrame(restoreArrangementScroll);
}

function refreshRightTimelineToolbar() {
  const slot = document.querySelector<HTMLElement>("#right-timeline-toolbar");
  if (!slot) return;
  slot.innerHTML = timelineToolbar(timelineZoomBounds(document.querySelector<HTMLElement>(".source-tracks")));
  bindTimelineControls(slot);
}

function scrollArrangementToEnd() {
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (tracks) {
    arrangementScrollLeft = Math.max(0, tracks.scrollWidth - tracks.clientWidth);
    setArrangementScroll(tracks, arrangementScrollLeft);
  }
}

function timelineContentOrigin(tracks: HTMLElement) {
  const track = tracks.querySelector<HTMLElement>(".source-track");
  if (!track) return 0;
  const paddingLeft = Number.parseFloat(window.getComputedStyle(track).paddingLeft) || 0;
  return track.offsetLeft + paddingLeft;
}

function syncTimelineGutters(tracks: HTMLElement) {
  const track = tracks.querySelector<HTMLElement>(".source-track");
  if (!track) return;
  const tracksStyle = window.getComputedStyle(tracks);
  const outerRight = Number.parseFloat(tracksStyle.paddingRight) || 0;
  const headX = tracks.clientWidth / 2;
  const left = Math.max(0, headX - track.offsetLeft);
  const right = Math.max(0, tracks.clientWidth - headX - outerRight);
  tracks.style.setProperty("--timeline-gutter-left", `${left}px`);
  tracks.style.setProperty("--timeline-gutter-right", `${right}px`);

  const missingStartTravel = Math.max(
    0,
    timelineHeadViewportX(tracks) - timelineContentOrigin(tracks)
  );
  if (missingStartTravel > 0.01) {
    tracks.style.setProperty("--timeline-gutter-left", `${left + missingStartTravel}px`);
  }

  // CSS grid sizing and scrollbar rounding can leave the theoretical final
  // Head-aligned position just beyond the browser's actual scroll range. Add
  // precisely the missing trailing space so both musical endpoints can
  // physically reach the Head.
  const desiredEndScrollLeft = Math.max(
    0,
    timelineContentOrigin(tracks)
      + timelinePosition(totalDuration(project.segments))
      - timelineHeadViewportX(tracks)
  );
  const maximumScrollLeft = Math.max(0, tracks.scrollWidth - tracks.clientWidth);
  const missingEndTravel = Math.max(0, desiredEndScrollLeft - maximumScrollLeft);
  if (missingEndTravel > 0.01) {
    tracks.style.setProperty("--timeline-gutter-right", `${right + missingEndTravel}px`);
  }
}

function timelineHeadViewportX(tracks: HTMLElement) {
  const head = tracks.querySelector<HTMLElement>(".arrangement-head");
  if (!head) return tracks.clientWidth / 2;
  const tracksBounds = tracks.getBoundingClientRect();
  const headBounds = head.getBoundingClientRect();
  return headBounds.left + headBounds.width / 2 - tracksBounds.left;
}

function centerArrangementOnHead() {
  centerArrangementOnElapsed(currentElapsed());
}

function restoreArrangementScroll() {
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (tracks) setArrangementScroll(tracks, arrangementScrollLeft);
}

function frameInitialTimeline() {
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (!tracks || !project.segments.length) return;
  timelineZoom = timelineZoomBounds(tracks).min;
  preferredTimelineZoom = timelineZoom;
  initialTimelineFramed = true;
  refreshTimeline(false);
  requestAnimationFrame(centerArrangementOnHead);
}

function changeTimelineZoom(delta: number) {
  const elapsedAtHead = currentElapsed();
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (captureSlot === null) setPanZoomMode("gesture", false);
  else {
    insertionPanZoomMode = "gesture";
    localStorage.setItem(INSERTION_PAN_ZOOM_KEY, insertionPanZoomMode);
  }
  const factor = delta < 0 ? 0.8 : 1.25;
  timelineZoom = clampTimelineZoom(timelineZoom * factor, tracks);
  preferredTimelineZoom = timelineZoom;
  refreshTimeline(false);
  requestAnimationFrame(() => centerArrangementOnElapsed(elapsedAtHead));
}

function timelineZoomBounds(tracks?: HTMLElement | null) {
  if (!project.segments.length) return { min: timelineZoom, max: timelineZoom };
  const labelWidth = window.innerWidth <= 850 ? 105 : 155;
  const viewportWidth = tracks?.clientWidth
    ?? Math.max(240, window.innerWidth - labelWidth - 220);
  const available = Math.max(80, viewportWidth - labelWidth);
  const gaps = Math.max(0, project.segments.length - 1) * TIMELINE_COLUMN_GAP;
  const contentWidth = (zoom: number) => timelineColumnWidths(zoom).reduce((sum, width) => sum + width, 0) + gaps;
  let low = TIMELINE_MIN_ZOOM;
  let high = Math.max(1, available / Math.max(0.1, totalDuration(project.segments)));
  while (contentWidth(high) <= available && high < 100_000) high *= 2;
  for (let step = 0; step < 24; step += 1) {
    const candidate = (low + high) / 2;
    if (contentWidth(candidate) <= available) low = candidate;
    else high = candidate;
  }
  const min = Number(Math.max(
    TIMELINE_MIN_ZOOM,
    Math.min(low / TIMELINE_ZOOM_OUT_RANGE, TIMELINE_MAX_ZOOM)
  ).toFixed(2));
  const shortestDuration = Math.min(...project.segments.map(segmentDuration));
  const dynamicMax = Math.max(min * 8, available / Math.max(0.1, shortestDuration));
  const max = Number(Math.max(min, Math.min(TIMELINE_MAX_ZOOM, dynamicMax)).toFixed(1));
  return { min, max };
}

function clampTimelineZoom(zoom: number, tracks?: HTMLElement | null) {
  const bounds = timelineZoomBounds(tracks);
  return Number(Math.max(bounds.min, Math.min(bounds.max, zoom)).toFixed(2));
}

function segmentIndividualZoom(index: number, tracks: HTMLElement) {
  const segment = project.segments[index];
  if (!segment) return preferredTimelineZoom;
  const track = tracks.querySelector<HTMLElement>(".source-track");
  const visibleTrackWidth = Math.max(
    TIMELINE_COLUMN_MIN_WIDTH,
    tracks.clientWidth - (track?.offsetLeft ?? 0) - TIMELINE_COLUMN_GAP
  );
  const targetSegmentWidth = visibleTrackWidth / 5;
  return Math.min(
    TIMELINE_MAX_ZOOM,
    Math.max(0.1, targetSegmentWidth / Math.max(0.1, segmentDuration(segment)))
  );
}

function adjacentPairZoom(index: number, neighbourIndex: number, tracks: HTMLElement) {
  const first = project.segments[index];
  const second = project.segments[neighbourIndex];
  if (!first || !second || index === neighbourIndex) return TIMELINE_MAX_ZOOM;
  const track = tracks.querySelector<HTMLElement>(".source-track");
  const visibleTrackWidth = Math.max(
    TIMELINE_COLUMN_MIN_WIDTH,
    tracks.clientWidth - (track?.offsetLeft ?? 0) - TIMELINE_COLUMN_GAP
  );
  const pairBudget = visibleTrackWidth * ADJACENT_PAIR_TRACK_BUDGET;
  const pairWidth = (zoom: number) => (
    Math.max(TIMELINE_COLUMN_MIN_WIDTH, segmentDuration(first) * zoom)
    + Math.max(TIMELINE_COLUMN_MIN_WIDTH, segmentDuration(second) * zoom)
    + TIMELINE_COLUMN_GAP
  );
  if (pairWidth(0.1) > pairBudget) return 0.1;
  let low = 0.1;
  let high = TIMELINE_MAX_ZOOM;
  for (let step = 0; step < 24; step += 1) {
    const candidate = (low + high) / 2;
    if (pairWidth(candidate) <= pairBudget) low = candidate;
    else high = candidate;
  }
  return Math.floor(low * 10) / 10;
}

function segmentBoundaryZoom(index: number, neighbourIndex: number, tracks: HTMLElement) {
  const pairLimit = adjacentPairZoom(index, neighbourIndex, tracks);
  const geometricMidpoint = Math.sqrt(
    segmentIndividualZoom(index, tracks) * segmentIndividualZoom(neighbourIndex, tracks)
  );
  return Math.max(0.1, Math.min(pairLimit, geometricMidpoint));
}

function adaptTimelineZoomAtHead(tracks: HTMLElement, elapsed: number) {
  if (activePanZoomMode() !== "dynamic") return;
  const index = findSegmentIndex(elapsed);
  const segment = project.segments[index];
  if (!segment) return;
  const duration = Math.max(0.1, segmentDuration(segment));
  const segmentProgress = Math.max(0, Math.min(1, (elapsed - segmentStart(index)) / duration));
  const segmentZoom = segmentIndividualZoom(index, tracks);
  const boundaryZoom = segmentProgress <= 0.5
    ? (index > 0 ? segmentBoundaryZoom(index, index - 1, tracks) : segmentZoom)
    : (index < project.segments.length - 1 ? segmentBoundaryZoom(index, index + 1, tracks) : segmentZoom);
  const curvedProgress = Math.sin(Math.PI * segmentProgress);
  const fromZoom = boundaryZoom;
  const toZoom = segmentZoom;
  const nextZoom = Number(Math.exp(
    Math.log(Math.max(0.1, fromZoom))
    + (Math.log(Math.max(0.1, toZoom)) - Math.log(Math.max(0.1, fromZoom))) * curvedProgress
  ).toFixed(1));
  if (nextZoom === timelineZoom) return;
  timelineZoom = nextZoom;
  applyTimelineZoomInPlace(tracks, elapsed);
}

function applyTimelineZoomInPlace(tracks: HTMLElement, elapsed: number) {
  const widths = timelineColumnWidths();
  const columns = widths.map((width) => `${width}px`).join(" ");
  tracks.querySelectorAll<HTMLElement>(".source-track, .time-axis").forEach((track) => {
    track.style.gridTemplateColumns = columns;
  });
  const axis = tracks.querySelector<HTMLElement>(".time-axis");
  if (axis) axis.innerHTML = timeAxisLabels(widths);
  tracks.querySelectorAll(".group-region").forEach((region) => region.remove());
  tracks.insertAdjacentHTML("beforeend", groupRegions(widths));
  const head = tracks.querySelector<HTMLElement>(".arrangement-head");
  if (head) head.style.setProperty("--head-x", `${timelinePosition(elapsed, widths)}px`);
  const zoomLabel = document.querySelector<HTMLElement>(".zoom-controls span");
  if (zoomLabel) zoomLabel.textContent = formatTimelineZoomLabel(timelineZoom, tracks);
  const bounds = timelineZoomBounds(tracks);
  const zoomOut = document.querySelector<HTMLButtonElement>("#zoom-out");
  if (zoomOut) zoomOut.disabled = timelineZoom <= bounds.min;
  const zoomIn = document.querySelector<HTMLButtonElement>("#zoom-in");
  if (zoomIn) zoomIn.disabled = timelineZoom >= bounds.max;
  if (!timelinePanActive) centerArrangementOnElapsed(elapsed);
}

function centerArrangementOnElapsed(elapsed: number, animate = false) {
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (!tracks) return;
  arrangementScrollLeft = Math.max(0, timelineContentOrigin(tracks) + timelinePosition(elapsed) - timelineHeadViewportX(tracks));
  setArrangementScroll(tracks, arrangementScrollLeft, animate);
}

function setArrangementScroll(tracks: HTMLElement, left: number, animate = false) {
  suppressArrangementScrollSync = true;
  window.clearTimeout(arrangementScrollSyncTimer);
  tracks.scrollTo({ left, behavior: animate ? "smooth" : "auto" });
  arrangementScrollSyncTimer = window.setTimeout(() => { suppressArrangementScrollSync = false; }, animate ? 400 : 0);
}

function restoreMixKeyboardFocus() {
  if (mode !== "mix" || !(document.activeElement instanceof HTMLIFrameElement)) return;
  document.querySelector<HTMLButtonElement>("#keyboard-capture")?.focus({ preventScroll: true });
}

function updateKeyboardContextHelp(context: "video" | "timeline") {
  mixFocusContext = context;
  const help = document.querySelector<HTMLElement>("#keyboard-context-help");
  if (!help) return;
  const heading = help.querySelector<HTMLElement>("b");
  const instructions = help.querySelector<HTMLElement>("p");
  const keyboardButton = document.querySelector<HTMLButtonElement>("#keyboard-capture");
  const timelineContext = context === "timeline";
  help.classList.toggle("timeline-context", timelineContext);
  help.classList.toggle("video-context", !timelineContext);
  if (heading) heading.textContent = timelineContext ? "TIMELINE FOCUS" : "VIDEO FOCUS";
  if (instructions) instructions.textContent = timelineContext
    ? "←/→ previous or next segment · Space play arrangement · +/− fixed zoom · Drag horizontally to pan · Fixed Zoom mode: drag vertically to zoom"
    : "←/→ scrub 1s · Shift + ←/→ scrub 15s · 0 start · 1–9 scrub + mark · Space start/finish · Enter add · +/− timeline zoom";
  if (keyboardButton) keyboardButton.textContent = timelineContext
    ? "Timeline ready · arrows change segment · Space plays · +/− zoom"
    : "Video ready · arrows scrub · Shift + arrows scrub 15s · Space start / finish";
  updateMixPrimaryAction();
  updateMixFocusToggle();
  updateGuidedVideoActions();
}

function beginLiveCapture(slot: number) {
  const source = sourceForSlot(slot);
  if (!source || !youtubePlayer || !playerReady) {
    pendingCaptureSlot = source ? slot : null;
    return;
  }
  previewStopAtEnd = null;
  cancelAnimationFrame(previewEndFrame);
  captureSlot = slot;
  captureSourceStart = Math.max(0, startValue);
  const insertionIndex = insertionIndexAtHead();
  captureSegmentId = crypto.randomUUID();
  project.segments.splice(insertionIndex, 0, {
    id: captureSegmentId,
    sourceId: source.id,
    sourceStartSeconds: captureSourceStart,
    sourceEndSeconds: captureSourceStart + 0.1,
    lane: 0,
  });
  lastAddedMomentId = captureSegmentId;
  refreshTimeline(false);
  requestAnimationFrame(centerArrangementOnHead);
  youtubePlayer.seekTo(captureSourceStart, true);
  youtubePlayer.playVideo();
  animateSegmentDefinition();
  setPlaybackStatus(`Recording source ${slot} · press a number to trigger the next moment`);
  updateGuidedVideoActions();
}

function animateSegmentDefinition() {
  cancelAnimationFrame(segmentDefinitionFrame);
  const update = () => {
    if (captureSlot === null || !youtubePlayer) return;
    const current = youtubePlayer.getCurrentTime();
    activeVideoDuration = Math.max(activeVideoDuration, youtubePlayer.getDuration() || 0, current);
    endValue = Math.max(captureSourceStart, current);
    const captured = project.segments.find((segment) => segment.id === captureSegmentId);
    if (captured) captured.sourceEndSeconds = Math.max(captureSourceStart + 0.1, current);
    const endInput = document.querySelector<HTMLInputElement>("#end-time");
    if (endInput) endInput.value = endValue.toFixed(1);
    const readout = document.querySelector<HTMLElement>(".duration-readout b");
    if (readout) readout.textContent = formatTime(endValue - captureSourceStart);
    updateSegmentDefinitionRuler();
    updateCaptureTimeline();
    segmentDefinitionFrame = requestAnimationFrame(update);
  };
  segmentDefinitionFrame = requestAnimationFrame(update);
}

function updateCaptureTimeline() {
  const captured = project.segments.find((segment) => segment.id === captureSegmentId);
  if (!captured) return;
  const capturedIndex = project.segments.indexOf(captured);
  // Recording advances at the segment's right edge. Keep that edge under the
  // fixed playhead so the recorded material grows backward as a visible tail.
  pausedAt = segmentStart(capturedIndex) + segmentDuration(captured);
  activePlaybackIndex = capturedIndex;
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (tracks && insertionPanZoomMode === "dynamic") adaptTimelineZoomAtHead(tracks, pausedAt);
  const widths = timelineColumnWidths();
  const columns = widths.map((width) => `${width}px`).join(" ");
  document.querySelectorAll<HTMLElement>(".source-track, .time-axis").forEach((track) => {
    track.style.gridTemplateColumns = columns;
  });
  updateSegmentBar(document.querySelector<HTMLElement>(`.segment[data-segment="${captured.id}"]`), captured);
  centerArrangementOnElapsed(pausedAt);
  updateActiveTimelineMoment();
}

function markMomentAtScrubPoint(key: number) {
  const source = sourceForSlot(selectedSlot);
  const duration = youtubePlayer?.getDuration() ?? 0;
  if (!source || !youtubePlayer || !playerReady || !Number.isFinite(duration) || duration <= 0) {
    if (source) setPlaybackStatus("The active video is still loading · try that number again");
    else {
      message = "Choose a track with a video before marking moments.";
      render();
    }
    return;
  }
  const target = Number((duration * key / 10).toFixed(1));
  finishLiveCapture(youtubePlayer.getCurrentTime());
  captureSourceStart = target;
  startValue = target;
  endValue = Math.min(duration, target + 8);
  activeVideoDuration = duration;
  updateSegmentDefinitionRuler();
  beginLiveCapture(selectedSlot);
  setPlaybackStatus(`Moment starts at ${formatTime(target)} · press another number to set its end`);
}

function scrubActiveVideo(deltaSeconds: number) {
  const duration = youtubePlayer?.getDuration() ?? 0;
  if (!youtubePlayer || !playerReady || !Number.isFinite(duration) || duration <= 0) {
    setPlaybackStatus("The active video is still loading");
    return;
  }
  const target = Math.max(0, Math.min(duration, youtubePlayer.getCurrentTime() + deltaSeconds));
  youtubePlayer.seekTo(target, true);
  setPlaybackStatus(`Scrubbed to ${formatTime(target)}`);
}

function stopLiveCapture() {
  if (captureSlot === null && pendingCaptureSlot === null) return;
  finishLiveCapture();
  pendingCaptureSlot = null;
  youtubePlayer?.pauseVideo();
  render();
}

function toggleLiveCapture() {
  if (sourceVideoPlaying) {
    if (captureSlot !== null) finishLiveCapture();
    pendingCaptureSlot = null;
    cancelAnimationFrame(segmentDefinitionFrame);
    youtubePlayer?.pauseVideo();
    sourceVideoPlaying = false;
    setPlaybackStatus("Paused · press Space to resume and start a new moment");
    updateGuidedVideoActions();
    return;
  }
  const source = sourceForSlot(selectedSlot);
  if (!source || !youtubePlayer || !playerReady) {
    if (!source) {
      message = "Choose a track with a video before recording a moment.";
      render();
    } else setPlaybackStatus("The active video is still loading");
    return;
  }
  const current = Math.max(0, youtubePlayer.getCurrentTime());
  startValue = current;
  endValue = current;
  activeVideoDuration = Math.max(activeVideoDuration, youtubePlayer.getDuration() || 0);
  updateSegmentDefinitionRuler();
  beginLiveCapture(selectedSlot);
  sourceVideoPlaying = true;
  updateGuidedVideoActions();
}

function playActiveSegment() {
  const segment = project.segments[activePlaybackIndex];
  const source = segment && sourceForSegment(segment);
  if (!segment || !source || !youtubePlayer || !playerReady) return;
  const offset = Math.max(0, pausedAt - segmentStart(activePlaybackIndex));
  const sourceTimestamp = segment.sourceStartSeconds + offset;
  previewStopAtEnd = null;
  cancelAnimationFrame(previewEndFrame);
  pauseWhenFrameAvailable = false;
  if (playing) arrangementPlaybackTransitioning = true;
  if (
    frameBufferingEnabled
    && loadedVideoHasFrame
    && loadedVideoId === source.videoId
    && bufferedArrangementSegmentId === segment.id
    && Math.abs(youtubePlayer.getCurrentTime() - sourceTimestamp) <= BUFFERED_FRAME_MATCH_TOLERANCE_SECONDS
  ) {
    youtubePlayer.playVideo();
    return;
  }
  bufferedArrangementSegmentId = segment.id;
  loadedVideoId = source.videoId;
  youtubePlayer.loadVideoById({
    videoId: source.videoId,
    startSeconds: sourceTimestamp,
    endSeconds: playbackEndSeconds(activePlaybackIndex),
  });
}

function updateActiveMomentUi(segment: Segment) {
  const source = sourceForSegment(segment);
  if (!source) return;
  document.querySelector<HTMLElement>(".stage")?.style.setProperty("--slot-color", SLOT_COLORS[source.slot - 1]);
  const label = document.querySelector<HTMLElement>(".now-playing span");
  const title = document.querySelector<HTMLElement>(".now-playing h1");
  const times = document.querySelector<HTMLElement>(".now-playing p");
  if (label) label.textContent = `NOW PLAYING · SOURCE ${source.slot}`;
  if (title) title.textContent = source.title;
  if (times) times.textContent = `${formatTime(segment.sourceStartSeconds)} → ${formatTime(segment.sourceEndSeconds)}`;
}

function updateActiveTimelineMoment() {
  document.querySelectorAll<HTMLElement>(".segment[data-index]").forEach((card) => {
    const isActive = Number(card.dataset.index) === activePlaybackIndex;
    card.classList.toggle("under-head", isActive);
    card.classList.toggle("currently-playing", playing && isActive);
  });
  const previous = document.querySelector<HTMLButtonElement>("#previous-segment");
  if (previous) previous.disabled = activePlaybackIndex <= 0;
  const next = document.querySelector<HTMLButtonElement>("#next-segment");
  if (next) next.disabled = activePlaybackIndex >= project.segments.length - 1;
}

function updatePlayUi(elapsed: number) {
  const total = totalDuration(project.segments);
  const values = document.querySelectorAll<HTMLElement>(".transport > span");
  if (values.length === 2) {
    values[0].textContent = formatTime(elapsed);
    values[1].textContent = `−${formatTime(Math.max(0, total - elapsed))}`;
  }
  const progress = document.querySelector<HTMLElement>(".progress i");
  if (progress) progress.style.width = `${total ? Math.min(100, elapsed / total * 100) : 0}%`;
  const head = document.querySelector<HTMLElement>(".arrangement-head");
  if (head) {
    head.style.setProperty("--head-x", `${timelinePosition(elapsed)}px`);
    head.classList.toggle("playing", playing);
    head.setAttribute("aria-valuenow", elapsed.toFixed(1));
    const tracks = head.closest<HTMLElement>(".source-tracks");
    if (tracks && playing && !timelinePanActive) {
      adaptTimelineZoomAtHead(tracks, elapsed);
      centerArrangementOnHead();
    }
  }
  updateActiveTimelineMoment();
}

function toggleArrangementPlayback() {
  if (captureSlot !== null) stopLiveCapture();
  togglePlayback();
  updatePlaybackButtons();
}

function pauseTimelineFromVideoPlayer() {
  pausedAt = currentElapsed();
  playing = false;
  cancelAnimationFrame(animationFrame);
  activePlaybackIndex = findSegmentIndex(pausedAt);
  updatePlayUi(pausedAt);
  updatePlaybackButtons();
  updatePerformanceLabel("Paused", false);
}

function updatePlaybackButtons() {
  const transport = document.querySelector<HTMLButtonElement>("#play-toggle");
  if (transport) transport.textContent = playing ? "Ⅱ" : "▶";
  updateMixPrimaryAction();
}

function togglePlayback() {
  if (playing) {
    pausedAt = currentElapsed();
    playing = false;
    updateActiveTimelineMoment();
    cancelAnimationFrame(animationFrame);
    youtubePlayer?.pauseVideo();
    updatePlaybackButtons();
    updatePerformanceLabel("Paused", false);
    setPlaybackStatus("Paused");
    return;
  }
  if (pausedAt >= totalDuration(project.segments)) pausedAt = 0;
  activePlaybackIndex = findSegmentIndex(pausedAt);
  playing = true;
  playStartedAt = performance.now();
  if (playerReady) playActiveSegment();
  updatePlaybackButtons();
  updateActiveTimelineMoment();
  updatePerformanceLabel("Playing", true);
  tick();
}

function updatePerformanceLabel(label: string, live: boolean) {
  const container = document.querySelector<HTMLElement>(".performance-label");
  if (!container) return;
  const textNode = Array.from(container.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (textNode) textNode.textContent = label;
  container.querySelector("i")?.classList.toggle("live", live);
}

function tick() {
  if (!playing) return;
  const elapsed = currentElapsed();
  if (elapsed >= totalDuration(project.segments)) {
    playing = false;
    updateActiveTimelineMoment();
    pausedAt = totalDuration(project.segments);
    youtubePlayer?.pauseVideo();
    updatePlayUi(pausedAt);
    updatePlaybackButtons();
    updatePerformanceLabel("Complete", false);
    setPlaybackStatus("Mix complete");
    return;
  }
  const nextIndex = findSegmentIndex(elapsed);
  if (nextIndex !== activePlaybackIndex) {
    const previousIndex = activePlaybackIndex;
    activePlaybackIndex = nextIndex;
    updateActiveTimelineMoment();
    pausedAt = segmentStart(nextIndex);
    playStartedAt = performance.now();
    if (segmentsPlayContinuously(previousIndex, nextIndex)) {
      updateActiveMomentUi(project.segments[nextIndex]);
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    if (segmentsUseSameVideo(previousIndex, nextIndex)) {
      youtubePlayer?.seekTo(project.segments[nextIndex].sourceStartSeconds, true);
      youtubePlayer?.playVideo();
      updateActiveMomentUi(project.segments[nextIndex]);
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    playActiveSegment();
    updateActiveMomentUi(project.segments[nextIndex]);
    animationFrame = requestAnimationFrame(tick);
    return;
  }
  updatePlayUi(elapsed);
  animationFrame = requestAnimationFrame(tick);
}

function findSegmentIndex(elapsed: number) {
  let cursor = 0;
  for (let index = 0; index < project.segments.length; index += 1) {
    cursor += segmentDuration(project.segments[index]);
    if (elapsed < cursor) return index;
  }
  return Math.max(0, project.segments.length - 1);
}

function stopPlayback() {
  playing = false;
  pausedAt = 0;
  activePlaybackIndex = -1;
  youtubePlayer?.stopVideo();
  cancelAnimationFrame(animationFrame);
  updateActiveTimelineMoment();
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "z" || (event.ctrlKey && key === "y")) {
      event.preventDefault();
      if ((key === "z" && event.shiftKey) || key === "y") redoProject();
      else undoProject();
      return;
    }
  }
  if (isTypingTarget(event.target)) return;
  const timelineFocused = event.target instanceof HTMLElement && Boolean(event.target.closest(".timeline-section"));
  if (mode === "mix" && (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_")) {
    event.preventDefault();
    changeTimelineZoom(event.key === "+" || event.key === "=" ? 4 : -4);
    return;
  }
  if (mode === "mix" && timelineFocused && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    navigateSegment(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (mode === "mix" && timelineFocused && event.key === " ") {
    event.preventDefault();
    toggleArrangementPlayback();
    return;
  }
  if (mode === "mix" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const scrubDistance = event.shiftKey ? 15 : 1;
    scrubActiveVideo(event.key === "ArrowLeft" ? -scrubDistance : scrubDistance);
    return;
  }
  if (event.key === "0" && mode === "mix") { event.preventDefault(); markMomentAtScrubPoint(0); return; }
  if (/^[1-9]$/.test(event.key) && mode === "mix") { markMomentAtScrubPoint(Number(event.key)); return; }
  if (/^[1-9]$/.test(event.key) && mode === "browse") { selectSlot(Number(event.key)); return; }
  if (mode === "mix" && event.key === "Enter") addSegment();
  if (mode === "mix" && event.key === " ") { event.preventDefault(); toggleLiveCapture(); return; }
  if (mode === "play" && event.key === " ") { event.preventDefault(); togglePlayback(); }
  if (event.key === "0") { stopPlayback(); render(); }
});

document.addEventListener("focusin", (event) => {
  if (mode !== "mix") return;
  const target = event.target as HTMLElement;
  if (target.closest("#mix-primary-action, #mix-focus-toggle")) return;
  updateKeyboardContextHelp(target.closest(".timeline-section") ? "timeline" : "video");
});

window.addEventListener("resize", () => {
  window.clearTimeout(timelineResizeTimer);
  timelineResizeTimer = window.setTimeout(() => {
    if (mode !== "mix" || !project.segments.length) return;
    const elapsedAtHead = currentElapsed();
    const tracks = document.querySelector<HTMLElement>(".source-tracks");
    timelineZoom = clampTimelineZoom(timelineZoom, tracks);
    refreshTimeline(false);
    requestAnimationFrame(() => centerArrangementOnElapsed(elapsedAtHead));
  }, 120);
});

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

render();
window.setTimeout(() => {
  navigationRailCollapsed = true;
  document.querySelector(".app-shell")?.classList.add("rail-collapsed");
}, 5000);
