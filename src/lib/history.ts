export const HISTORY_KEY = "yt-studio.history.v1";
export const HISTORY_LIMIT = 100;
export interface HistoryVideo {
  videoId: string;
  title: string;
  author: string;
  visitedAt: number;
  saved: boolean;
}

export function readHistory(storage: Pick<Storage, "getItem">): HistoryVideo[] {
  const value = storage.getItem(HISTORY_KEY);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Invalid history format");
  const ids = new Set<string>();
  return parsed.filter((item): item is HistoryVideo => {
    if (!item || typeof item !== "object") return false;
    const row = item as HistoryVideo;
    if (!/^[\w-]{11}$/.test(row.videoId) || typeof row.title !== "string" || typeof row.author !== "string" || !Number.isFinite(row.visitedAt) || !Number.isFinite(new Date(row.visitedAt).getTime()) || typeof row.saved !== "boolean" || ids.has(row.videoId)) return false;
    ids.add(row.videoId);
    return true;
  }).slice(0, HISTORY_LIMIT).map((row) => ({ videoId: row.videoId, title: row.title.slice(0, 500), author: row.author.slice(0, 200), visitedAt: row.visitedAt, saved: row.saved }));
}

export function rememberVideo(history: HistoryVideo[], video: Pick<HistoryVideo, "videoId" | "title" | "author">, now = Date.now()): HistoryVideo[] {
  return [{ ...video, visitedAt: now, saved: history.find((item) => item.videoId === video.videoId)?.saved ?? false }, ...history.filter((item) => item.videoId !== video.videoId)].slice(0, HISTORY_LIMIT);
}

export function writeHistory(storage: Pick<Storage, "setItem">, history: HistoryVideo[]) {
  // Only lightweight metadata is stored. Media files and signed caption URLs
  // are never persisted. Storage denial/quota errors are surfaced by the UI.
  storage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}
