// YouTube utilities

export function extractVideoId(url: string): string | null {
  const value = url.trim();
  // URL parsing handles mobile/music hosts, URL-encoded query strings and
  // links where `v` is not the first query parameter. Restrict hosts so a
  // lookalike domain cannot be accepted accidentally.
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const allowedHost = host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
    if (allowedHost) {
      let candidate = "";
      if (host === "youtu.be") candidate = parsed.pathname.split("/").filter(Boolean)[0] || "";
      else if (parsed.pathname === "/watch") candidate = parsed.searchParams.get("v") || "";
      else {
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (["embed", "shorts", "live", "v"].includes(parts[0] || "")) candidate = parts[1] || "";
      }
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) return candidate;
    }
  } catch {
    // Fall through to the raw-ID check below.
  }
  // Raw 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  return null;
}

export function getEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`;
}

export function getThumbnail(videoId: string, quality: "max" | "hq" | "mq" | "sd" = "hq"): string {
  const map = { max: "maxresdefault", hq: "hqdefault", mq: "mqdefault", sd: "sddefault" };
  return `https://img.youtube.com/vi/${videoId}/${map[quality]}.jpg`;
}

export async function fetchVideoInfo(videoId: string): Promise<VideoInfo> {
  // Use YouTube oEmbed API (no key needed)
  const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("Could not fetch video info");
  const data = await res.json();
  return {
    videoId,
    title: data.title,
    author: data.author_name,
    authorUrl: data.author_url,
    thumbnail: data.thumbnail_url,
  };
}

export interface VideoInfo {
  videoId: string;
  title: string;
  author: string;
  authorUrl: string;
  thumbnail: string;
}
