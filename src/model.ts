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
  return segment.sourceEndSeconds - segment.sourceStartSeconds;
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
