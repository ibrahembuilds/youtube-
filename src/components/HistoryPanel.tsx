import { useState } from "react";
import { Search, Clock, Bookmark, Trash2, Play, ArrowUpRight } from "lucide-react";
import type { HistoryVideo } from "../lib/history";
import { getThumbnail } from "../lib/youtube";

export default function HistoryPanel({ videos, onOpen, onChange, savedOnly = false }: {
  videos: HistoryVideo[]; onOpen: (id: string) => void;
  onChange: (videos: HistoryVideo[]) => void; savedOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const filtered = videos.filter((item) => (!savedOnly || item.saved) && `${item.title} ${item.author} ${item.videoId}`.toLowerCase().includes(search.toLowerCase()));
  return <section aria-label={savedOnly ? "Saved videos" : "Video history"} className="history-panel">
    <div className="section-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{savedOnly ? "Saved videos" : "Video history"}</h1><p>Pick up where your curiosity left off.</p></div><span className="count-pill">{filtered.length} videos</span></div>
    <div className="history-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Search history" placeholder="Search by title or channel…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>{videos.length > 0 && <button className="btn-ghost" onClick={() => setConfirmClear(true)}><Trash2 size={15} /> Clear history</button>}</div>
    {confirmClear && <div className="confirmation" role="alert"><p>Remove all video history and bookmarks from this browser?</p><button className="btn-primary" onClick={() => { onChange([]); setConfirmClear(false); }}>Yes, clear all</button><button className="btn-secondary" onClick={() => setConfirmClear(false)}>Cancel</button></div>}
    {filtered.length === 0 ? <div className="history-empty"><Clock size={32} /><h2>{search ? "No videos match your search" : savedOnly ? "Keep your best finds here" : "Your next insight starts with a video"}</h2><p>{search ? "Try another title or channel." : savedOnly ? "Use the bookmark button on any video in your history." : "Videos you open in the studio appear here automatically."}</p></div> : <div className="history-grid">{filtered.map((item) => <article className="history-card" key={item.videoId}>
      <button className="history-thumbnail" onClick={() => onOpen(item.videoId)} aria-label={`Open ${item.title}`}><img src={getThumbnail(item.videoId)} alt="" loading="lazy" /><span><Play size={20} fill="currentColor" /></span></button>
      <div className="history-card-body"><p className="history-channel">{item.author || "YouTube video"}</p><button className="history-title" onClick={() => onOpen(item.videoId)}>{item.title}</button><div className="history-card-footer"><time dateTime={new Date(item.visitedAt).toISOString()}>{new Date(item.visitedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><div><button aria-label={`${item.saved ? "Unsave" : "Save"} ${item.title}`} aria-pressed={item.saved} className={`icon-button ${item.saved ? "is-saved" : ""}`} onClick={() => onChange(videos.map((v) => v.videoId === item.videoId ? { ...v, saved: !v.saved } : v))}><Bookmark size={16} fill={item.saved ? "currentColor" : "none"} /></button><button className="icon-button" aria-label={`Remove ${item.title}`} onClick={() => onChange(videos.filter((v) => v.videoId !== item.videoId))}><Trash2 size={16} /></button></div></div></div>
    </article>)}</div>}
    <p className="storage-note"><ArrowUpRight size={14} /> Last 100 videos, stored in this browser. Clearing browser data removes them. Reopening needs internet; video files are not downloaded.</p>
  </section>;
}
