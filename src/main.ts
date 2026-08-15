import "./styles.css";
import {
  EMPTY_PROJECT,
  SLOT_COLORS,
  formatTime,
  parseYouTubeId,
  segmentDuration,
  totalDuration,
  type MixProject,
  type Mode,
  type Segment,
  type Source,
} from "./model";

const STORAGE_KEY = "music-mixer-project-v1";
const app = document.querySelector<HTMLDivElement>("#app")!;

let project = loadProject();
let mode: Mode = "mix";
let selectedSlot = project.sources[0]?.slot ?? 1;
let editingSlot: number | null = null;
let message = "";
let startValue = 0;
let endValue = 8;
let playing = false;
let playStartedAt = 0;
let pausedAt = 0;
let animationFrame = 0;
let activePlaybackIndex = -1;
let playerGeneration = 0;
let playerReady = false;
let youtubePlayer: YouTubePlayer | null = null;
let youtubeApiPromise: Promise<void> | null = null;
let captureSlot: number | null = null;
let captureSourceStart = 0;
let pendingCaptureSlot: number | null = null;
let timelineZoom = 18;
const selectedMomentIds = new Set<string>();

type YouTubePlayer = {
  cueVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  loadVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
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
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="#" aria-label="Music Mixer home">
          <span class="brand-mark"><i></i><i></i><i></i><i></i></span>
          <span>MUSIC<br>MIXER</span>
        </a>
        <nav class="modes" aria-label="Workspace mode">
          ${(["browse", "mix", "play"] as Mode[]).map((item, index) => `
            <button class="mode ${mode === item ? "active" : ""}" data-mode="${item}">
              <span>0${index + 1}</span>${item}
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
    if (mode === "mix") scrollArrangementToEnd();
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
        <button class="primary" data-mode="mix" ${count ? "" : "disabled"}>Start mixing <span>→</span></button>
      </footer>
    </section>`;
}

function sourceTile(slot: number, compact = false) {
  const source = sourceForSlot(slot);
  const color = SLOT_COLORS[slot - 1];
  return `
    <button class="source-tile ${source ? "filled" : "empty"} ${compact ? "compact" : ""} ${selectedSlot === slot ? "selected" : ""}"
      style="--slot-color:${color}" data-slot="${slot}" aria-label="${source ? `Edit slot ${slot}, ${escapeHtml(source.title)}` : `Add video to slot ${slot}`}">
      <span class="slot-number">${slot}</span>
      ${source ? `
        <img src="https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg" alt="" />
        <span class="tile-shade"></span><span class="tile-title">${escapeHtml(source.title)}</span>
      ` : `<span class="plus">+</span><span class="empty-label">Add a video</span>`}
    </button>`;
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
            ${message ? `<p class="form-error" role="alert">${escapeHtml(message)}</p>` : ""}
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
        <section class="mock-player" style="--slot-color:${SLOT_COLORS[selectedSlot - 1]}">
          ${source ? `<div id="youtube-player" class="youtube-player"></div><span class="mock-badge">YouTube preview · sound on</span>` : `<div class="no-source"><span>${selectedSlot}</span><p>Add a video to this slot in Browse mode.</p><button class="text-button" data-mode="browse">Go to Browse →</button></div>`}
        </section>
        <section class="segment-editor">
          <p class="eyebrow">SEGMENT FROM SOURCE ${selectedSlot}</p>
          <h2>${escapeHtml(source?.title ?? "Empty source")}</h2>
          <button id="keyboard-capture" class="keyboard-capture" type="button">Keyboard ready · 1–9 scrub + mark · 0 / Space finish</button>
          <div class="time-fields">
            <label>Start <span>seconds</span><input id="start-time" type="number" min="0" step="0.1" value="${startValue}" /></label>
            <span class="time-arrow">→</span>
            <label>End <span>seconds</span><input id="end-time" type="number" min="0" step="0.1" value="${endValue}" /></label>
          </div>
          <div class="duration-readout"><span>Moment length</span><b>${formatTime(endValue - startValue)}</b></div>
          ${message ? `<p class="form-error" role="alert">${escapeHtml(message)}</p>` : ""}
          <div class="bound-buttons"><button id="set-start">Set start at playhead</button><button id="set-end">Set end at playhead</button></div>
          <button class="preview-button" id="preview-segment" ${source ? "" : "disabled"}>▶ Preview this clip with sound</button>
          <button class="primary wide" id="add-segment" ${source ? "" : "disabled"}>Add to mix <span>＋</span></button>
          <p class="shortcut">Shortcuts: <kbd>1</kbd>–<kbd>9</kbd> scrub to 10%–90% + mark · <kbd>Space</kbd> finish · <kbd>Enter</kbd> add</p>
        </section>
      </div>
      ${timelineView()}
    </section>`;
}

function timelineView() {
  const duration = totalDuration(project.segments);
  const sources = [...project.sources].sort((a, b) => a.slot - b.slot);
  const columnWidths = project.segments.map((segment) => Math.max(36, segmentDuration(segment) * timelineZoom));
  const columns = columnWidths.map((width) => `${width}px`).join(" ");
  const elapsed = currentElapsed();
  return `
    <section class="timeline-section">
      <div class="timeline-heading"><div><p class="eyebrow">ARRANGEMENT</p><h2>${project.segments.length ? `${project.segments.length} moments · ${formatTime(duration)}` : "Your mix is empty"}</h2></div><div class="timeline-tools">${selectionTools()}<div class="zoom-controls" aria-label="Moment zoom"><button id="zoom-out" aria-label="Zoom out">−</button><span>${timelineZoom}px/s</span><button id="zoom-in" aria-label="Zoom in">＋</button></div>${project.segments.length ? `<button class="primary" id="arrangement-play">${playing ? "Pause" : "Play arrangement"} <span>${playing ? "Ⅱ" : "▶"}</span></button>` : ""}</div></div>
      <div class="timeline source-tracks">
        <div class="time-label">TIME</div><div class="time-axis" style="grid-template-columns:${columns || "minmax(190px, 1fr)"}">${timeAxisLabels()}</div>
        ${sources.map((source) => `<button class="track-label ${selectedSlot === source.slot ? "selected" : ""}" style="--slot-color:${SLOT_COLORS[source.slot - 1]}" data-slot="${source.slot}" title="Switch to ${escapeHtml(source.title)}"><b>${source.slot}</b><span>${escapeHtml(source.title)}</span></button><div class="source-track" style="grid-template-columns:${columns || "minmax(190px, 1fr)"}" data-source="${source.id}">${project.segments.length ? project.segments.map((segment, index) => segment.sourceId === source.id ? segmentCard(segment, index) : `<span class="moment-gap" aria-hidden="true"></span>`).join("") : `<span class="track-empty">Press <kbd>${source.slot}</kbd> to record a moment</span>`}</div>`).join("")}
        ${project.segments.length ? `<i class="arrangement-head ${playing ? "playing" : ""}" style="--head-x:${timelinePosition(elapsed, columnWidths)}px" aria-hidden="true"></i>` : ""}
      </div>
      <button class="add-track-video" data-mode="browse"><span>＋</span> Add track video</button>
    </section>`;
}

function selectionTools() {
  const count = selectedMomentIds.size;
  if (!count) return "";
  return `<div class="selection-tools" role="toolbar" aria-label="Selected moments"><span>${count} selected</span><button data-bulk-action="duplicate">Duplicate</button><button data-bulk-action="delete">Delete</button><button data-bulk-action="group" ${count < 2 ? "disabled" : ""}>Group</button><button data-bulk-action="ungroup">Ungroup</button></div>`;
}

function timeAxisLabels() {
  let elapsed = 0;
  return project.segments.map((segment) => {
    const label = `<span><i></i>${formatTimePrecise(elapsed)}</span>`;
    elapsed += segmentDuration(segment);
    return label;
  }).join("");
}

function formatTimePrecise(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

function timelinePosition(elapsed: number, widths = project.segments.map((segment) => Math.max(36, segmentDuration(segment) * timelineZoom))) {
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

function segmentCard(segment: Segment, index: number) {
  const source = sourceForSegment(segment);
  const slot = source?.slot ?? 1;
  const duration = segmentDuration(segment);
  return `<article class="segment ${selectedMomentIds.has(segment.id) ? "selected" : ""} ${segment.groupId ? "grouped" : ""}" style="--slot-color:${SLOT_COLORS[slot - 1]};--segment-width:${Math.min(520, Math.max(190, duration * 18))}px" data-segment="${segment.id}" ${segment.groupId ? `data-group="${segment.groupId}"` : ""}>
    <span class="segment-index">${String(index + 1).padStart(2, "0")}</span><b>${slot}</b>
    ${segment.groupId ? `<span class="group-badge" title="Grouped moment">G</span>` : ""}
    <span class="segment-info"><strong>${escapeHtml(source?.title ?? "Missing source")}</strong><small>${formatTime(segment.sourceStartSeconds)} → ${formatTime(segment.sourceEndSeconds)}</small></span>
    <button data-action="duplicate" data-id="${segment.id}" aria-label="Duplicate segment">⧉</button>
    <button data-action="delete" data-id="${segment.id}" aria-label="Delete segment">×</button>
    <div class="duration-bar" aria-label="${duration.toFixed(1)} second moment">
      <button class="trim-handle trim-start" data-trim="start" data-id="${segment.id}" aria-label="Drag to change segment start"></button>
      <span><i></i><em>${duration.toFixed(1)}s</em></span>
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
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode as Mode)));
  document.querySelectorAll<HTMLElement>("[data-slot]").forEach((tile) => tile.addEventListener("click", () => selectSlot(Number(tile.dataset.slot))));
  document.querySelector("#close-picker")?.addEventListener("click", () => { editingSlot = null; message = ""; render(); });
  document.querySelector<HTMLFormElement>("#source-form")?.addEventListener("submit", assignSource);
  document.querySelector<HTMLInputElement>("#project-title")?.addEventListener("change", (event) => { project.title = (event.target as HTMLInputElement).value.trim() || "Untitled mix"; saveProject(); render(); });
  document.querySelector("#add-segment")?.addEventListener("click", addSegment);
  document.querySelector("#preview-segment")?.addEventListener("click", previewSegment);
  document.querySelector("#set-start")?.addEventListener("click", () => setBoundFromPlayer("start"));
  document.querySelector("#set-end")?.addEventListener("click", () => setBoundFromPlayer("end"));
  document.querySelector<HTMLInputElement>("#start-time")?.addEventListener("input", updateTimeValues);
  document.querySelector<HTMLInputElement>("#end-time")?.addEventListener("input", updateTimeValues);
  bindTimelineEvents(document);
  document.querySelector("#play-toggle")?.addEventListener("click", togglePlayback);
  document.querySelector("#stop")?.addEventListener("click", () => { stopPlayback(); render(); });
  bindTimelineControls(document);
}

function bindTimelineControls(root: ParentNode) {
  root.querySelector("#arrangement-play")?.addEventListener("click", toggleArrangementPlayback);
  root.querySelector("#zoom-out")?.addEventListener("click", () => changeTimelineZoom(-4));
  root.querySelector("#zoom-in")?.addEventListener("click", () => changeTimelineZoom(4));
}

function bindTimelineEvents(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => button.addEventListener("click", () => editSegment(button.dataset.action!, button.dataset.id!)));
  root.querySelectorAll<HTMLButtonElement>("[data-trim]").forEach((handle) => handle.addEventListener("pointerdown", beginTrim));
  root.querySelectorAll<HTMLElement>(".segment[data-segment]").forEach((item) => {
    item.addEventListener("pointerdown", beginSegmentReorder);
    item.addEventListener("click", selectMoment);
  });
  root.querySelectorAll<HTMLElement>("[data-bulk-action]").forEach((button) => button.addEventListener("click", () => bulkEditMoments(button.dataset.bulkAction!)));
}

function selectMoment(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("button")) return;
  const card = event.currentTarget as HTMLElement;
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

function bulkEditMoments(action: string) {
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
  const nextStart = Number(document.querySelector<HTMLInputElement>("#start-time")?.value ?? 0);
  const nextEnd = Number(document.querySelector<HTMLInputElement>("#end-time")?.value ?? 0);
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
  project.segments.push({ id: crypto.randomUUID(), sourceId: source.id, sourceStartSeconds: startValue, sourceEndSeconds: endValue, lane: 0 });
  saveProject();
  message = "";
  render();
}

function editSegment(action: string, id: string) {
  const index = project.segments.findIndex((segment) => segment.id === id);
  if (index < 0) return;
  if (action === "delete") {
    project.segments.splice(index, 1);
    selectedMomentIds.delete(id);
  }
  if (action === "duplicate") project.segments.splice(index + 1, 0, { ...project.segments[index], id: crypto.randomUUID() });
  cleanupMomentGroups();
  saveProject();
  render();
}

function reorderSegment(fromId: string, toId: string) {
  const fromSegment = project.segments.find((segment) => segment.id === fromId);
  if (!fromSegment || !project.segments.some((segment) => segment.id === toId)) return;
  const moving = fromSegment.groupId ? project.segments.filter((segment) => segment.groupId === fromSegment.groupId) : [fromSegment];
  if (moving.some((segment) => segment.id === toId)) return;
  const movingIds = new Set(moving.map((segment) => segment.id));
  const remaining = project.segments.filter((segment) => !movingIds.has(segment.id));
  const targetIndex = remaining.findIndex((segment) => segment.id === toId);
  remaining.splice(targetIndex < 0 ? remaining.length : targetIndex, 0, ...moving);
  project.segments = remaining;
  saveProject();
  if (mode === "mix") refreshTimeline(false);
  else render();
}

function beginSegmentReorder(event: PointerEvent) {
  const card = event.currentTarget as HTMLElement;
  if ((event.target as HTMLElement).closest("button")) return;
  const fromId = card.dataset.segment;
  if (!fromId) return;
  const originX = event.clientX;
  const originY = event.clientY;
  let dragging = false;
  card.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    if (!dragging && Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) > 6) {
      dragging = true;
      card.dataset.dragged = "true";
      card.classList.add("dragging");
    }
  };
  const end = (endEvent: PointerEvent) => {
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerup", end);
    card.removeEventListener("pointercancel", cancel);
    card.classList.remove("dragging");
    if (!dragging) return;
    const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>("[data-segment]");
    if (target?.dataset.segment) reorderSegment(fromId, target.dataset.segment);
  };
  const cancel = () => {
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerup", end);
    card.removeEventListener("pointercancel", cancel);
    card.classList.remove("dragging");
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
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    const deltaSeconds = (moveEvent.clientX - originX) / 12;
    if (edge === "start") segment.sourceStartSeconds = Number(Math.max(0, Math.min(originalEnd - 0.1, originalStart + deltaSeconds)).toFixed(1));
    else segment.sourceEndSeconds = Number(Math.max(originalStart + 0.1, originalEnd + deltaSeconds).toFixed(1));
    updateSegmentBar(handle.closest<HTMLElement>(".segment"), segment);
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    saveProject();
    render();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function updateSegmentBar(card: HTMLElement | null, segment: Segment) {
  if (!card) return;
  const duration = segmentDuration(segment);
  card.style.setProperty("--segment-width", `${Math.min(520, Math.max(190, duration * 18))}px`);
  const small = card.querySelector(".segment-info small");
  if (small) small.textContent = `${formatTime(segment.sourceStartSeconds)} → ${formatTime(segment.sourceEndSeconds)}`;
  const label = card.querySelector(".duration-bar em");
  if (label) label.textContent = `${duration.toFixed(1)}s`;
}

function segmentStart(index: number) {
  return project.segments.slice(0, index).reduce((sum, segment) => sum + segmentDuration(segment), 0);
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
  try {
    youtubePlayer?.destroy();
  } catch { /* The preceding render may already have removed its iframe. */ }
  youtubePlayer = null;
  setPlaybackStatus("Loading YouTube player…");
  try {
    await loadYouTubeApi();
    if (generation !== playerGeneration || !document.querySelector("#youtube-player")) return;
    youtubePlayer = new window.YT!.Player("youtube-player", {
      width: "100%",
      height: "100%",
      videoId: source.videoId,
      host: "https://www.youtube-nocookie.com",
      playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
      events: {
        onReady: () => {
          if (generation !== playerGeneration) return;
          playerReady = true;
          setPlaybackStatus(mode === "play" ? "Ready · sound on" : "Ready to preview with sound");
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
          if (event.data === 3) setPlaybackStatus("Buffering…");
          if (event.data === 1) setPlaybackStatus(captureSlot === null ? "Playing with sound" : `Recording source ${captureSlot}`);
          if (event.data === 2) setPlaybackStatus("Paused");
          restoreMixKeyboardFocus();
        },
        onError: (event: { data: number }) => {
          playing = false;
          cancelAnimationFrame(animationFrame);
          setPlaybackStatus(`This video cannot be played here (error ${event.data}).`);
        },
      },
    });
  } catch (error) {
    setPlaybackStatus(error instanceof Error ? error.message : "YouTube player could not be loaded.");
  }
}

function setPlaybackStatus(status: string) {
  const element = document.querySelector<HTMLElement>(".playback-status, .mock-badge");
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
  youtubePlayer.loadVideoById({ videoId: source.videoId, startSeconds: startValue, endSeconds: endValue });
  setPlaybackStatus("Playing clip with sound");
}

function setBoundFromPlayer(bound: "start" | "end") {
  if (!youtubePlayer || !playerReady) return;
  const time = Math.max(0, Number(youtubePlayer.getCurrentTime().toFixed(1)));
  if (bound === "start") {
    const preservedDuration = Math.max(0.1, endValue - startValue);
    startValue = time;
    endValue = time + preservedDuration;
  }
  else endValue = time;
  render();
}

function finishLiveCapture(sourceEnd = youtubePlayer?.getCurrentTime()) {
  if (captureSlot === null) return;
  const source = sourceForSlot(captureSlot);
  const end = Number(sourceEnd);
  if (source && Number.isFinite(end) && end > captureSourceStart) {
    project.segments.push({
      id: crypto.randomUUID(),
      sourceId: source.id,
      sourceStartSeconds: captureSourceStart,
      sourceEndSeconds: Number(end.toFixed(1)),
      lane: 0,
    });
    saveProject();
    refreshTimeline(true);
  }
  captureSlot = null;
}

function refreshTimeline(scrollToEnd = false) {
  if (mode !== "mix") return;
  const current = document.querySelector<HTMLElement>(".timeline-section");
  if (!current) return;
  current.outerHTML = timelineView();
  const next = document.querySelector<HTMLElement>(".timeline-section");
  if (!next) return;
  next.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode as Mode)));
  next.querySelectorAll<HTMLElement>("[data-slot]").forEach((button) => button.addEventListener("click", () => selectSlot(Number(button.dataset.slot))));
  bindTimelineEvents(next);
  bindTimelineControls(next);
  if (scrollToEnd) requestAnimationFrame(scrollArrangementToEnd);
}

function scrollArrangementToEnd() {
  const tracks = document.querySelector<HTMLElement>(".source-tracks");
  if (tracks) tracks.scrollLeft = Math.max(0, tracks.scrollWidth - tracks.clientWidth);
}

function changeTimelineZoom(delta: number) {
  timelineZoom = Math.max(6, Math.min(54, timelineZoom + delta));
  refreshTimeline(true);
}

function restoreMixKeyboardFocus() {
  if (mode !== "mix" || !(document.activeElement instanceof HTMLIFrameElement)) return;
  document.querySelector<HTMLButtonElement>("#keyboard-capture")?.focus({ preventScroll: true });
}

function beginLiveCapture(slot: number) {
  const source = sourceForSlot(slot);
  if (!source || !youtubePlayer || !playerReady) {
    pendingCaptureSlot = source ? slot : null;
    return;
  }
  captureSlot = slot;
  captureSourceStart = Math.max(0, startValue);
  youtubePlayer.seekTo(captureSourceStart, true);
  youtubePlayer.playVideo();
  setPlaybackStatus(`Recording source ${slot} · press a number to trigger the next moment`);
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
  captureSlot = selectedSlot;
  captureSourceStart = target;
  startValue = target;
  endValue = Math.min(duration, target + 8);
  youtubePlayer.seekTo(target, true);
  youtubePlayer.playVideo();
  setPlaybackStatus(`Moment starts at ${formatTime(target)} · press another number to set its end`);
}

function stopLiveCapture() {
  if (captureSlot === null && pendingCaptureSlot === null) return;
  finishLiveCapture();
  pendingCaptureSlot = null;
  youtubePlayer?.pauseVideo();
  render();
}

function playActiveSegment() {
  const segment = project.segments[activePlaybackIndex];
  const source = segment && sourceForSegment(segment);
  if (!segment || !source || !youtubePlayer || !playerReady) return;
  const offset = Math.max(0, pausedAt - segmentStart(activePlaybackIndex));
  youtubePlayer.loadVideoById({ videoId: source.videoId, startSeconds: segment.sourceStartSeconds + offset, endSeconds: segment.sourceEndSeconds });
}

function seekToActiveSegment() {
  const segment = project.segments[activePlaybackIndex];
  if (!segment || !youtubePlayer || !playerReady) return;
  youtubePlayer.seekTo(segment.sourceStartSeconds, true);
  youtubePlayer.playVideo();
  updateActiveMomentUi(segment);
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
    const tracks = head.closest<HTMLElement>(".source-tracks");
    if (tracks && playing) {
      const headX = timelinePosition(elapsed) + 155;
      if (headX > tracks.scrollLeft + tracks.clientWidth - 80) tracks.scrollLeft = headX - tracks.clientWidth + 80;
    }
  }
}

function toggleArrangementPlayback() {
  if (captureSlot !== null) stopLiveCapture();
  togglePlayback();
  updatePlaybackButtons();
}

function updatePlaybackButtons() {
  const transport = document.querySelector<HTMLButtonElement>("#play-toggle");
  if (transport) transport.textContent = playing ? "Ⅱ" : "▶";
  const arrangement = document.querySelector<HTMLButtonElement>("#arrangement-play");
  if (arrangement) arrangement.innerHTML = playing ? `Pause <span>Ⅱ</span>` : `Play arrangement <span>▶</span>`;
}

function togglePlayback() {
  if (playing) {
    pausedAt = currentElapsed();
    playing = false;
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
    pausedAt = totalDuration(project.segments);
    youtubePlayer?.stopVideo();
    updatePlayUi(pausedAt);
    updatePlaybackButtons();
    updatePerformanceLabel("Complete", false);
    setPlaybackStatus("Mix complete");
    return;
  }
  const nextIndex = findSegmentIndex(elapsed);
  if (nextIndex !== activePlaybackIndex) {
    const previousSource = sourceForSegment(project.segments[activePlaybackIndex]);
    const nextSource = sourceForSegment(project.segments[nextIndex]);
    activePlaybackIndex = nextIndex;
    pausedAt = segmentStart(nextIndex);
    playStartedAt = performance.now();
    if (previousSource?.videoId === nextSource?.videoId) {
      seekToActiveSegment();
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
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

document.addEventListener("keydown", (event) => {
  if (isTypingTarget(event.target)) return;
  if (/^[1-9]$/.test(event.key) && mode === "mix") { markMomentAtScrubPoint(Number(event.key)); return; }
  if (/^[1-9]$/.test(event.key) && mode === "browse") { selectSlot(Number(event.key)); return; }
  if (mode === "mix" && event.key === "Enter") addSegment();
  if (mode === "mix" && (event.key === " " || event.key === "0")) { event.preventDefault(); stopLiveCapture(); return; }
  if (mode === "play" && event.key === " ") { event.preventDefault(); togglePlayback(); }
  if (event.key === "0") { stopPlayback(); render(); }
});

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

render();
