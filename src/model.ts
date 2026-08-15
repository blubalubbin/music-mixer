export type Mode = "browse" | "mix" | "play";

export type Source = {
  id: string;
  slot: number;
  videoId: string;
  originalUrl: string;
  title: string;
};

export type Segment = {
  id: string;
  sourceId: string;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  lane: 0 | 1;
  playbackRate?: number;
  groupId?: string;
};

export type MixProject = {
  version: 1;
  title: string;
  sources: Source[];
  segments: Segment[];
};

export const EMPTY_PROJECT: MixProject = {
  version: 1,
  title: "Untitled mix",
  sources: [],
  segments: [],
};

export type ProjectParseResult =
  | { ok: true; project: MixProject }
  | { ok: false; error: string };

export function parseMixProject(value: unknown): ProjectParseResult {
  if (!isRecord(value) || value.version !== 1) return invalid("This is not a Music Mixer v1 project.");
  if (typeof value.title !== "string" || !Array.isArray(value.sources) || !Array.isArray(value.segments)) {
    return invalid("The project file is missing its title, sources, or segments.");
  }

  const sourceIds = new Set<string>();
  const slots = new Set<number>();
  const sources: Source[] = [];
  for (const item of value.sources) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.videoId !== "string"
      || !/^[\w-]{11}$/.test(item.videoId) || typeof item.originalUrl !== "string"
      || typeof item.title !== "string" || typeof item.slot !== "number" || !Number.isInteger(item.slot) || item.slot < 1 || item.slot > 9) {
      return invalid("The project contains an invalid source video.");
    }
    if (sourceIds.has(item.id) || slots.has(item.slot)) return invalid("Source IDs and slots must be unique.");
    sourceIds.add(item.id);
    slots.add(item.slot);
    sources.push({ id: item.id, slot: item.slot, videoId: item.videoId, originalUrl: item.originalUrl, title: item.title });
  }

  const segmentIds = new Set<string>();
  const segments: Segment[] = [];
  for (const item of value.segments) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.sourceId !== "string"
      || !sourceIds.has(item.sourceId) || !isFiniteNumber(item.sourceStartSeconds) || item.sourceStartSeconds < 0
      || !isFiniteNumber(item.sourceEndSeconds) || item.sourceEndSeconds <= item.sourceStartSeconds
      || (item.lane !== 0 && item.lane !== 1)
      || (item.playbackRate !== undefined && (!isFiniteNumber(item.playbackRate) || item.playbackRate < 0.25 || item.playbackRate > 2))
      || (item.groupId !== undefined && (typeof item.groupId !== "string" || !item.groupId))) {
      return invalid("The project contains an invalid timeline segment.");
    }
    if (segmentIds.has(item.id)) return invalid("Timeline segment IDs must be unique.");
    segmentIds.add(item.id);
    segments.push({
      id: item.id,
      sourceId: item.sourceId,
      sourceStartSeconds: item.sourceStartSeconds,
      sourceEndSeconds: item.sourceEndSeconds,
      lane: item.lane,
      ...(item.playbackRate && item.playbackRate !== 1 ? { playbackRate: item.playbackRate } : {}),
      ...(item.groupId ? { groupId: item.groupId } : {}),
    });
  }

  return { ok: true, project: { version: 1, title: value.title.trim() || "Untitled mix", sources, segments } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalid(error: string): ProjectParseResult {
  return { ok: false, error };
}

export const SLOT_COLORS = [
  "#ff6047", "#ffb329", "#d6d936", "#58c77a", "#35c3bd",
  "#4fa6ff", "#8777ff", "#d168dc", "#f4619d",
];

export function parseYouTubeId(value: string): string | null {
  const input = value.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return validId(url.pathname.split("/")[1]);
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") return validId(url.searchParams.get("v"));
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      return validId(match?.[1] ?? null);
    }
  } catch {
    return null;
  }
  return null;
}

function validId(value: string | null | undefined): string | null {
  return value && /^[\w-]{11}$/.test(value) ? value : null;
}

export function segmentDuration(segment: Segment): number {
  return (segment.sourceEndSeconds - segment.sourceStartSeconds) / (segment.playbackRate ?? 1);
}

export function totalDuration(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
