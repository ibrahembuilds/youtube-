import { useEffect, useMemo, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Play, Sparkles, MessageCircle, Download, Scissors, Loader2, Send, FileText, List, CheckCircle, Clock, Globe, Languages, Plus, Bookmark, ArrowUpRight, LayoutGrid, HardDrive, Link2 } from "lucide-react";
import HistoryPanel from "@/components/HistoryPanel";
import ExportText from "@/components/ExportText";
import { HISTORY_KEY, readHistory, rememberVideo, writeHistory, type HistoryVideo } from "@/lib/history";
import { extractVideoId, getEmbedUrl, fetchVideoInfo, type VideoInfo } from "@/lib/youtube";
import {
  fetchTranscriptMeta, fetchAllTranscriptContent, fetchTranscriptContent,
  translateTranscript, chatWithVideo, generateSummary, generateViralShorts,
  getDownloadInfo, formatTranscriptText, formatTimestamp, transcriptCoverage, TranscriptLookupError,
  type ChatMessage, type TranscriptSegment, type TranscriptResult,
  type TranscriptTrack, type ViralShort, type DownloadInfo,
} from "@/lib/ai";

type Tab = "watch" | "transcript" | "chat" | "summary" | "viral" | "download";

// Paired with a language code, because the only reliable way to tell "this is
// already the transcript's language" is to compare codes. A track's display
// name carries qualifiers ("Portuguese (Brazil)", "English (auto-generated)")
// that never match a plain list entry.
const SUPPORTED_LANGUAGES: { name: string; code: string }[] = [
  { name: "Arabic", code: "ar" },
  { name: "Chinese (Simplified)", code: "zh" },
  { name: "Chinese (Traditional)", code: "zh" },
  { name: "Dutch", code: "nl" },
  { name: "English", code: "en" },
  { name: "French", code: "fr" },
  { name: "German", code: "de" },
  { name: "Hindi", code: "hi" },
  { name: "Indonesian", code: "id" },
  { name: "Italian", code: "it" },
  { name: "Japanese", code: "ja" },
  { name: "Korean", code: "ko" },
  { name: "Malay", code: "ms" },
  { name: "Portuguese", code: "pt" },
  { name: "Russian", code: "ru" },
  { name: "Spanish", code: "es" },
  { name: "Thai", code: "th" },
  { name: "Turkish", code: "tr" },
  { name: "Vietnamese", code: "vi" },
];

/** Base language code, so "pt-BR" and "pt" compare equal. */
function baseCode(code: string | undefined): string {
  return (code || "").toLowerCase().split(/[-_]/)[0];
}

/** The language the viewer most likely wants, that is not the transcript's own. */
function defaultTargetLanguage(trackCode: string | undefined): string {
  const track = baseCode(trackCode);
  const preferred = typeof navigator !== "undefined" ? navigator.languages || [navigator.language] : [];
  for (const tag of preferred) {
    const hit = SUPPORTED_LANGUAGES.find((l) => l.code === baseCode(tag));
    if (hit && hit.code !== track) return hit.name;
  }
  return (SUPPORTED_LANGUAGES.find((l) => l.code !== track) || SUPPORTED_LANGUAGES[0]).name;
}

const EMPTY_SEGMENTS: TranscriptSegment[] = [];

export default function Studio() {
  const [view, setView] = useState<"studio" | "history" | "saved">("studio");
  const [history, setHistory] = useState<HistoryVideo[]>([]);
  const [storageError, setStorageError] = useState("");
  const historyRef = useRef<HistoryVideo[]>([]);
  useEffect(() => {
    const sync = () => { try { const items = readHistory(localStorage); historyRef.current = items; setHistory(items); } catch { setStorageError("Local history is unavailable or damaged. Videos still work; clear history to start fresh."); } };
    sync();
    const onStorage = (event: StorageEvent) => { if (event.key === HISTORY_KEY || event.key === null) sync(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  function updateHistory(items: HistoryVideo[]) {
    historyRef.current = items;
    setHistory(items);
    try { writeHistory(localStorage, items); setStorageError(""); } catch { setStorageError("This browser could not save your history. Check available storage and browser privacy settings."); }
  }
  const contextVersion = useRef(0);
  const translationVersion = useRef(0);
  useEffect(() => () => { contextVersion.current++; }, []);
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [playStart, setPlayStart] = useState(0);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [transcriptMeta, setTranscriptMeta] = useState<TranscriptResult | null>(null);
  const [trackSegments, setTrackSegments] = useState<Map<number, TranscriptSegment[]>>(new Map());
  const [selectedTrackIndex, setSelectedTrackIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState("");
  const [errorIsRetryable, setErrorIsRetryable] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("watch");

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // Summary state
  const [summary, setSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryType, setSummaryType] = useState<"brief" | "detailed" | "bullet" | "takeaways">("brief");

  // Viral state
  const [shorts, setShorts] = useState<ViralShort[]>([]);
  const [viralLoading, setViralLoading] = useState(false);

  // Download state
  const [downloadInfo, setDownloadInfo] = useState<DownloadInfo | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);

  // Translation state
  const [targetLanguage, setTargetLanguage] = useState("English");
  const [translatedText, setTranslatedText] = useState("");
  const [translating, setTranslating] = useState(false);

  // Derived state
  // Memoised because the `|| []` fallback would otherwise hand downstream
  // hooks a brand-new array on every render.
  const selectedSegments = useMemo(
    () => trackSegments.get(selectedTrackIndex) ?? EMPTY_SEGMENTS,
    [trackSegments, selectedTrackIndex]
  );
  const selectedTrack = transcriptMeta?.tracks?.[selectedTrackIndex] ?? null;
  const transcriptText = formatTranscriptText(selectedSegments);

  const trackCode = selectedTrack?.languageCode;

  // The AI context is capped, so on a long video the summary and shorts are
  // built from only the opening stretch. Silently returning a partial answer
  // reads as a complete one, so say what was covered.
  const coverage = useMemo(() => transcriptCoverage(selectedSegments), [selectedSegments]);

  // Translating a transcript into its own language is a no-op, and the button
  // for it is disabled. Defaulting the dropdown to "English" therefore left the
  // whole feature dead on arrival for every English video — which is most of
  // them. Move off the transcript's own language as soon as it is known.
  useEffect(() => {
    if (!trackCode) return;
    setTargetLanguage((current) => {
      const currentCode = SUPPORTED_LANGUAGES.find((l) => l.name === current)?.code;
      return currentCode === baseCode(trackCode) ? defaultTargetLanguage(trackCode) : current;
    });
  }, [trackCode]);

  const targetIsSameLanguage = useMemo(() => {
    const targetCode = SUPPORTED_LANGUAGES.find((l) => l.name === targetLanguage)?.code;
    return !!targetCode && targetCode === baseCode(trackCode);
  }, [targetLanguage, trackCode]);

  function newVideo() {
    contextVersion.current++;
    translationVersion.current++;
    setView("studio"); setUrl(""); setVideoId(null); setVideoInfo(null);
    setTranscriptMeta(null); setTrackSegments(new Map()); setSelectedTrackIndex(0);
    setLoading(false); setLoadingTranscript(false); setError("");
    setChatLoading(false); setSummaryLoading(false); setViralLoading(false);
    setTranslating(false); setDownloadLoading(false); setChatMessages([]);
    setSummary(""); setShorts([]); setTranslatedText(""); setDownloadInfo(null);
    requestAnimationFrame(() => document.getElementById("video-url")?.focus());
  }

  async function handleLoad(sourceUrl = url) {
    if (loading) return;
    setError("");
    setErrorIsRetryable(false);
    const id = extractVideoId(sourceUrl);
    if (!id) { setError("Please enter a valid YouTube URL"); return; }
    const version = ++contextVersion.current;
    setView("studio");
    setUrl(sourceUrl);
    updateHistory(rememberVideo(historyRef.current, { videoId: id, title: historyRef.current.find((item) => item.videoId === id)?.title || `YouTube video · ${id}`, author: historyRef.current.find((item) => item.videoId === id)?.author || "" }));
    setChatLoading(false);
    setSummaryLoading(false);
    setViralLoading(false);
    setTranslating(false);
    setDownloadLoading(false);
    setChatInput("");

    setLoading(true);
    setVideoId(id);
    setPlayStart(0);
    setVideoInfo(null);
    setTranscriptMeta(null);
    setTrackSegments(new Map());
    setSelectedTrackIndex(0);
    setTranslatedText("");
    setChatMessages([]);
    setSummary("");
    setShorts([]);
    setDownloadInfo(null);
    setActiveTab("watch");

    // Video info (oEmbed) is a nice-to-have — fetch it independently so a
    // hiccup there can't take down the transcript/chat/summary features.
    const [infoResult, metaResult] = await Promise.allSettled([
      fetchVideoInfo(id),
      fetchTranscriptMeta(id),
    ]);
    if (version !== contextVersion.current) return;

    if (infoResult.status === "fulfilled") {
      setVideoInfo(infoResult.value);
      // Do not recreate an entry deleted while metadata was loading.
      if (historyRef.current.some((item) => item.videoId === id)) {
        updateHistory(historyRef.current.map((item) => item.videoId === id ? { ...item, title: infoResult.value.title, author: infoResult.value.author } : item));
      }
    }

    if (metaResult.status === "rejected") {
      const err: any = metaResult.reason;
      setError(err.message || "Something went wrong");
      // Rate limiting clears on its own; no captions never will.
      setErrorIsRetryable(
        err instanceof TranscriptLookupError &&
          (err.code === "throttled" ||
            err.code === "bot_check" ||
            err.code === "upstream_error")
      );
      setLoading(false);
      return;
    }

    const meta = metaResult.value;
    setTranscriptMeta(meta);

    try {
      // Fetch actual transcript content from BROWSER (not server)
      setLoadingTranscript(true);
      const allSegments = await fetchAllTranscriptContent(meta.tracks);
      if (version !== contextVersion.current) return;
      const newMap = new Map<number, TranscriptSegment[]>();
      allSegments.forEach((segs, i) => {
        if (segs) newMap.set(i, segs);
      });
      setTrackSegments(newMap);
      if (!newMap.has(0) && newMap.size) setSelectedTrackIndex(newMap.keys().next().value!);
    } finally {
      if (version === contextVersion.current) {
        setLoading(false);
        setLoadingTranscript(false);
      }
    }
  }

  async function handleSwitchTrack(index: number) {
    if (loading || index === selectedTrackIndex) return;
    const version = ++contextVersion.current;
    setChatLoading(false);
    setSummaryLoading(false);
    setViralLoading(false);
    setTranslating(false);
    setDownloadLoading(false);
    setError("");
    setSelectedTrackIndex(index);
    setTranslatedText("");
    // AI output is grounded in the selected transcript. Clear it when the
    // language changes instead of showing an answer generated from another
    // track while the new one is loading.
    setChatMessages([]);
    setSummary("");
    setShorts([]);

    // If we haven't loaded this track's segments yet, fetch them now (browser-side)
    if (!trackSegments.has(index) && transcriptMeta?.tracks[index]) {
      setLoadingTranscript(true);
      try {
        const segs = await fetchTranscriptContent(transcriptMeta.tracks[index]);
        if (version !== contextVersion.current) return;
        setTrackSegments((prev) => {
          const next = new Map(prev);
          next.set(index, segs);
          return next;
        });
      } catch {
        if (version === contextVersion.current) setError("Could not load this caption track. Choose another language or reload the video.");
      } finally {
        if (version === contextVersion.current) setLoadingTranscript(false);
      }
    }
  }

  async function handleTranslate() {
    if (!selectedSegments.length || translating) return;
    const version = contextVersion.current;
    const translation = ++translationVersion.current;
    setError("");
    setTranslating(true);
    setTranslatedText("");
    try {
      const result = await translateTranscript(selectedSegments, targetLanguage);
      if (version !== contextVersion.current || translation !== translationVersion.current) return;
      setTranslatedText(result);
    } catch (err: any) {
      if (version === contextVersion.current && translation === translationVersion.current) setError(err.message || "Translation failed");
    } finally {
      if (version === contextVersion.current && translation === translationVersion.current) setTranslating(false);
    }
  }

  async function handleChat() {
    if (!chatInput.trim() || chatLoading || !transcriptText) return;
    const version = contextVersion.current;
    setError("");
    const userMsg: ChatMessage = { role: "user", content: chatInput };
    const newMessages = [...chatMessages, userMsg];
    setChatMessages(newMessages);
    setChatInput("");
    setChatLoading(true);
    try {
      const response = await chatWithVideo(videoId!, newMessages, transcriptText);
      if (version !== contextVersion.current) return;
      setChatMessages([...newMessages, { role: "assistant", content: response }]);
    } catch (err: any) {
      if (version === contextVersion.current) {
        setChatMessages(chatMessages);
        setChatInput(userMsg.content);
        setError(err.message || "Chat failed. Try again.");
      }
    } finally {
      if (version === contextVersion.current) setChatLoading(false);
    }
  }

  async function handleSummary(typeOverride = summaryType) {
    if (summaryLoading || !transcriptText) return;
    const version = contextVersion.current;
    setError("");
    setSummaryLoading(true);
    setSummary("");
    try {
      const result = await generateSummary(videoId!, transcriptText, typeOverride);
      if (version !== contextVersion.current) return;
      setSummary(result);
    } catch (err: any) {
      if (version !== contextVersion.current) return;
      setSummary("");
      setError(err.message || "Summary generation failed");
    } finally {
      if (version === contextVersion.current) setSummaryLoading(false);
    }
  }

  async function handleViral() {
    if (viralLoading || !transcriptText) return;
    const version = contextVersion.current;
    setError("");
    setViralLoading(true);
    setShorts([]);
    try {
      const result = await generateViralShorts(videoId!, transcriptText);
      if (version !== contextVersion.current) return;
      setShorts(result);
    } catch (err: any) {
      if (version === contextVersion.current) setError(err.message);
    } finally {
      if (version === contextVersion.current) setViralLoading(false);
    }
  }

  async function handleDownload() {
    if (downloadLoading) return;
    const version = contextVersion.current;
    setError("");
    setDownloadLoading(true);
    try {
      const info = await getDownloadInfo(videoId!);
      if (version !== contextVersion.current) return;
      setDownloadInfo(info);
    } catch (err: any) {
      if (version === contextVersion.current) setError(err.message);
    } finally {
      if (version === contextVersion.current) setDownloadLoading(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "watch", label: "Watch", icon: Play },
    { id: "transcript", label: "Transcript", icon: FileText },
    { id: "chat", label: "Chat", icon: MessageCircle },
    { id: "summary", label: "Summary", icon: List },
    { id: "viral", label: "Viral Shorts", icon: Scissors },
    { id: "download", label: "Download", icon: Download },
  ];

  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <Link to="/" className="studio-brand"><span><Play size={19} fill="currentColor" /></span>YT Studio<span className="brand-dot">.</span></Link>
        <button className="new-video-button" onClick={newVideo}><Plus size={18} /> New video</button>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="Workspace navigation">
          <button className={view === "studio" ? "active" : ""} onClick={() => setView("studio")}><LayoutGrid size={18} /> Studio</button>
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><Clock size={18} /> History <span>{history.length}</span></button>
          <button className={view === "saved" ? "active" : ""} onClick={() => setView("saved")}><Bookmark size={18} /> Saved <span>{history.filter((item) => item.saved).length}</span></button>
        </nav>
        <div className="sidebar-recents"><p className="sidebar-label">RECENT VIDEOS</p>{history.slice(0, 5).map((item) => <button key={item.videoId} disabled={loading} onClick={() => handleLoad(item.videoId)} title={item.title}><Play size={13} /><span>{item.title}</span></button>)}{!history.length && <p>Your recently opened videos will appear here.</p>}</div>
        <div className="sidebar-bottom"><HardDrive size={17} /><div><strong>Your space. Your browser.</strong><p>History is saved locally.</p></div></div>
      </aside>
      <div className="studio-main">
      <header className="studio-topbar">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="text-sm text-ink-600">Workspace <span className="mx-2 text-ink-300">/</span> <strong className="text-ink-900">{view === "studio" ? "Studio" : view === "history" ? "History" : "Saved"}</strong></span>
          <div className="flex items-center gap-3">
            {transcriptMeta && (
              <div className="badge bg-green-50 text-green-600">
                <CheckCircle className="w-3 h-3" />
                {trackSegments.size} transcript{trackSegments.size !== 1 ? "s" : ""} ready
                {loadingTranscript && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="studio-content">
        {storageError && <div className="confirmation" role="alert">{storageError}<button className="btn-secondary" onClick={() => updateHistory([])}>Clear history</button></div>}
        {view !== "studio" && <HistoryPanel key={view} savedOnly={view === "saved"} videos={history} onChange={updateHistory} onOpen={(id) => { if (!loading) handleLoad(id); }} />}
        <div hidden={view !== "studio"}>
        <div className="section-heading"><div><p className="eyebrow">LESS WATCHING. MORE UNDERSTANDING.</p><h1>{videoId ? "Video workspace" : "What will you discover today?"}</h1><p>Turn a YouTube video into notes, answers, and your next idea.</p></div><span className="workspace-label"><Sparkles size={14} /> AI workspace</span></div>
        {/* URL Input */}
        <div className="video-input-card">
          <label htmlFor="video-url" className="video-input-label"><Link2 size={16} /> Start with a YouTube link</label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="video-url"
              type="text"
              aria-label="YouTube video URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLoad()}
              placeholder="Paste YouTube link here..."
              className="input flex-1"
              disabled={loading}
            />
            <button onClick={() => handleLoad()} className="btn-primary whitespace-nowrap sm:min-w-[120px]" disabled={loading || !url}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load Video"}
            </button>
          </div>
          {error && (
            <div role="alert" className="mt-3 flex items-start gap-3">
              <p className="text-sm text-red-500">{error}</p>
              {errorIsRetryable && (
                <button
                  onClick={() => handleLoad()}
                  disabled={loading}
                  className="btn-ghost text-xs border border-ink-200 shrink-0"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>

        {/* Language selector */}
        {transcriptMeta && transcriptMeta.tracks.length > 1 && (
          <div className="mb-4 flex items-center gap-2 flex-wrap">
            <Globe className="w-4 h-4 text-ink-400" />
            <span className="text-sm text-ink-500">Transcript:</span>
            {transcriptMeta.tracks.map((track, i) => (
              <button
                key={i}
                disabled={loading}
                onClick={() => handleSwitchTrack(i)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  i === selectedTrackIndex
                    ? "bg-ink-900 text-white"
                    : "bg-ink-100 text-ink-600 hover:bg-ink-200"
                }`}
              >
                {track.languageName}
                {track.kind === "asr" && " (auto)"}
              </button>
            ))}
          </div>
        )}

        {videoId && (
          <div className="animate-fade-in">
            <div className="video-workspace-grid">
            <div className="video-column"><WatchTab videoId={videoId} videoInfo={videoInfo} selectedTrack={selectedTrack} segmentCount={selectedSegments.length} start={playStart} />
              <a className="source-link" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">Open original video <ArrowUpRight size={15} /></a>
              <button className="btn-secondary w-full mt-3" onClick={() => updateHistory(historyRef.current.map((item) => item.videoId === videoId ? { ...item, saved: !item.saved } : item))}><Bookmark size={16} />{history.find((item) => item.videoId === videoId)?.saved ? "Saved to your videos" : "Save video"}</button>
            </div>
            <div className="tool-column">
            {videoInfo && (
              <div className="mb-4">
                <h2 className="text-xl font-semibold">{videoInfo.title}</h2>
                <div className="flex items-center gap-3 mt-1">
                  <p className="text-sm text-ink-500">{videoInfo.author}</p>
                  {selectedTrack && (
                    <span className="badge bg-blue-50 text-blue-600 text-xs">
                      {selectedTrack.languageName}
                      {selectedSegments.length > 0 && ` (${selectedSegments.length} segments)`}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="tool-tabs flex gap-1 mb-6 border-b border-ink-100 overflow-x-auto">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (tab.id === "summary" && !summary && !summaryLoading && transcriptText) handleSummary();
                    if (tab.id === "viral" && shorts.length === 0 && !viralLoading && transcriptText) handleViral();
                    if (tab.id === "download" && !downloadInfo && !downloadLoading) handleDownload();
                  }}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    activeTab === tab.id
                      ? "border-ink-900 text-ink-900"
                      : "border-transparent text-ink-400 hover:text-ink-600"
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="min-h-[400px]">
              {activeTab === "watch" && <div className="tool-overview"><div className="overview-icon"><Sparkles size={28} /></div><h2>Your video, unpacked.</h2><p>Read along, get the main points, or ask a question. Choose a tool above to get started.</p><div className="overview-features">{[{ id: "transcript" as const, label: "Read the transcript", icon: FileText }, { id: "chat" as const, label: "Ask a question", icon: MessageCircle }, { id: "summary" as const, label: "Get the key points", icon: List }].map((tool) => <button key={tool.id} onClick={() => setActiveTab(tool.id)}><tool.icon size={17} /><span>{tool.label}</span><ArrowUpRight size={16} /></button>)}</div></div>}
              {coverage.truncated && activeTab !== "watch" && activeTab !== "download" && (
                <div className="mb-4 badge bg-amber-50 text-amber-700">
                  <Clock className="w-3 h-3" />
                  AI reads the first {formatTimestamp(coverage.lastIncludedStart)} of this video
                  ({coverage.includedSegments} of {coverage.totalSegments} segments)
                </div>
              )}
              {activeTab === "transcript" && (
                <TranscriptTab
                  key={`${videoId}-${selectedTrackIndex}`}
                  onSeek={setPlayStart}
                  segments={selectedSegments}
                  track={selectedTrack}
                  loading={loadingTranscript}
                  translatedText={translatedText}
                  targetLanguage={targetLanguage}
                  setTargetLanguage={(language) => { translationVersion.current++; setTargetLanguage(language); setTranslatedText(""); setTranslating(false); }}
                  onTranslate={handleTranslate}
                  translating={translating}
                  targetIsSameLanguage={targetIsSameLanguage}
                  onClearTranslation={() => setTranslatedText("")}
                />
              )}
              {activeTab === "chat" && (
                <ChatTab messages={chatMessages} input={chatInput} setInput={setChatInput} onSend={handleChat} loading={chatLoading} hasTranscript={selectedSegments.length > 0} />
              )}
              {activeTab === "summary" && (
                <SummaryTab summary={summary} loading={summaryLoading} type={summaryType} setType={setSummaryType} onRegenerate={handleSummary} hasTranscript={selectedSegments.length > 0} />
              )}
              {activeTab === "viral" && (
                <ViralTab shorts={shorts} loading={viralLoading} onRegenerate={handleViral} hasTranscript={selectedSegments.length > 0} />
              )}
              {activeTab === "download" && (
                <DownloadTab info={downloadInfo} loading={downloadLoading} onRetry={handleDownload} />
              )}
            </div>
            </div></div>
          </div>
        )}

        {!videoId && !loading && (
          <div className="studio-empty">
            <div className="empty-visual"><div className="visual-video"><Play size={30} fill="currentColor" /><span /><span /><span /></div><div className="visual-note"><Sparkles size={16} /><i /><i /><i /></div></div>
            <h2>A little less scrolling.<br />A lot more clarity.</h2>
            <p>Bring a lecture, interview, or deep dive.<br />Leave with something you can use.</p>
            <div className="empty-tool-grid">{[{ icon: FileText, title: "Read & translate", desc: "Follow every word in your language." }, { icon: MessageCircle, title: "Ask & understand", desc: "Answers grounded in the transcript." }, { icon: Scissors, title: "Find your next clip", desc: "Hooks, scripts, and moments worth sharing." }].map((tool) => <div key={tool.title}><tool.icon size={21} /><h3>{tool.title}</h3><p>{tool.desc}</p></div>)}</div>
          </div>
        )}
      </div>
      </div></div>
    </div>
  );
}

// ─── Tab Components ──────────────────────────────────────────────────

function WatchTab({ videoId, videoInfo, selectedTrack, segmentCount, start }: {
  videoId: string; videoInfo: VideoInfo | null; selectedTrack: TranscriptTrack | null; segmentCount: number; start: number;
}) {
  return (
    <div className="watch-details">
      <div>
        <div className="aspect-video rounded-2xl overflow-hidden bg-ink-900">
          <iframe title={videoInfo?.title || "YouTube video player"} src={`${getEmbedUrl(videoId)}&start=${Math.floor(start)}`} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
        </div>
      </div>
      <div>
        {videoInfo && (
          <div className="card p-4 mb-4">
            <h3 className="font-semibold text-sm">{videoInfo.title}</h3>
            <p className="text-xs text-ink-500 mt-1">{videoInfo.author}</p>
          </div>
        )}
        {selectedTrack && (
          <div className="card p-4">
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><Globe className="w-4 h-4" />Transcript Info</h3>
            <div className="space-y-2 text-sm text-ink-500">
              <div className="flex justify-between"><span>Language</span><span className="font-medium text-ink-700">{selectedTrack.languageName}</span></div>
              <div className="flex justify-between"><span>Type</span><span className="font-medium text-ink-700">{selectedTrack.kind === "asr" ? "Auto-generated" : "Manual"}</span></div>
              <div className="flex justify-between"><span>Segments loaded</span><span className="font-medium text-ink-700">{segmentCount}</span></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TranscriptTab({
  segments, track, loading, translatedText, targetLanguage, setTargetLanguage, onTranslate, translating,
  onClearTranslation, targetIsSameLanguage,
  onSeek,
}: {
  segments: TranscriptSegment[]; track: TranscriptTrack | null; loading: boolean;
  translatedText: string; targetLanguage: string; setTargetLanguage: (v: string) => void;
  onTranslate: () => void; translating: boolean; onClearTranslation: () => void;
  targetIsSameLanguage: boolean;
  onSeek: (seconds: number) => void;
}) {
  const [search, setSearch] = useState("");
  const visibleSegments = segments.filter((segment) => segment.text.toLowerCase().includes(search.toLowerCase()));
  if (loading) {
    return (
      <div className="flex items-center gap-3 text-ink-400 py-20 justify-center">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading transcript from YouTube...</span>
      </div>
    );
  }

  if (!track) {
    return (
      <div className="text-center py-20">
        <FileText className="w-8 h-8 text-ink-300 mx-auto mb-3" />
        <p className="text-ink-400 text-sm">No transcript available for this video.</p>
      </div>
    );
  }

  if (segments.length === 0 && !translatedText) {
    return (
      <div className="text-center py-20">
        <FileText className="w-8 h-8 text-ink-300 mx-auto mb-3" />
        <p className="text-ink-400 text-sm">Could not load transcript for {track.languageName}. The captions may be unavailable.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="card p-4 mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-ink-400" />
            <span className="text-sm font-medium">{track.languageName}{track.kind === "asr" && <span className="text-ink-400 font-normal ml-1">(auto-generated)</span>}</span>
            <span className="text-xs text-ink-400">• {segments.length} segments</span>
          </div>
          {/* Wraps at phone width — unwrapped, this row pushed the Translate
              button 10px past a 390px viewport, where it could not be tapped. */}
          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:ml-auto">
            <span className="text-sm text-ink-400 flex items-center gap-1">
              <Languages className="w-3.5 h-3.5" />Translate to:
            </span>
            <select
              id="translate-target"
              aria-label="Translation language"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              className="text-sm border border-ink-200 rounded-lg px-2 py-1.5 bg-white min-w-0 flex-1 sm:flex-none"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.name} value={lang.name}>{lang.name}</option>
              ))}
            </select>
            <button
              onClick={onTranslate}
              disabled={translating || targetIsSameLanguage}
              title={targetIsSameLanguage ? `This transcript is already in ${targetLanguage}` : undefined}
              className="btn-primary text-xs py-1.5 px-3 whitespace-nowrap"
            >
              {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Translate"}
            </button>
          </div>
        </div>
        {translatedText && (
          <div className="mt-3 pt-3 border-t border-ink-100 flex items-center gap-2">
            <span className="badge bg-green-50 text-green-600 text-xs">Translated to {targetLanguage}</span>
            <button onClick={onClearTranslation} className="text-xs text-ink-400 hover:text-ink-600">Show original</button>
          </div>
        )}
      </div>
      <div className="card p-6">
        <ExportText text={translatedText || segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n")} filename="yt-studio-transcript.txt" />
        {!translatedText && <input aria-label="Search transcript" className="input mb-4 text-sm" placeholder="Find a word or moment…" value={search} onChange={(event) => setSearch(event.target.value)} />}
        {!translatedText && search && <p className="text-xs text-ink-600 mb-3">{visibleSegments.length} matching segments</p>}
        <div className="max-h-[600px] overflow-y-auto">
          {translatedText ? (
            // dir="auto" lets the browser pick the paragraph direction from the
            // text itself, so an Arabic or Hebrew translation reads correctly
            // instead of being laid out left-to-right.
            <p dir="auto" className="whitespace-pre-wrap text-sm text-ink-700 leading-relaxed">
              {translatedText}
            </p>
          ) : (
            // One row per segment rather than a single pre-wrapped string.
            // As one string the timestamp became part of the line's bidi run,
            // which pushed [0:00] to the visual END of every right-to-left
            // line. Separating the cells keeps timestamps in a left column for
            // every script, and lets each caption lay itself out.
            <div className="text-sm text-ink-700 leading-relaxed">
              {visibleSegments.map((seg, i) => (
                <div key={i} className="flex gap-3 py-0.5">
                  <button aria-label={`Seek to ${formatTimestamp(seg.start)}`} onClick={() => onSeek(seg.start)} className="shrink-0 text-ink-400 font-mono text-xs pt-0.5 tabular-nums select-none">
                    {formatTimestamp(seg.start)}
                  </button>
                  <span dir="auto" className="min-w-0 flex-1">{seg.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatTab({ messages, input, setInput, onSend, loading, hasTranscript }: {
  messages: ChatMessage[]; input: string; setInput: (v: string) => void; onSend: () => void; loading: boolean; hasTranscript: boolean;
}) {
  return (
    <div className="flex flex-col h-[500px]">
      {!hasTranscript ? (
        <div className="flex items-center justify-center h-full"><p className="text-ink-400 text-sm">No transcript available for this video. Chat requires captions.</p></div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto space-y-4 pr-2">
            {messages.length === 0 && (
              <div className="text-center py-12">
                <MessageCircle className="w-8 h-8 text-ink-300 mx-auto mb-3" />
                <p className="text-ink-400 text-sm">Ask anything about this video</p>
                <div className="mt-4 flex flex-wrap gap-2 justify-center">
                  {["What is this video about?", "Key takeaways?", "Best moments?"].map((s) => (
                    <button key={s} onClick={() => setInput(s)} className="btn-ghost text-xs border border-ink-200">{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${msg.role === "user" ? "bg-ink-900 text-white" : "bg-ink-100 text-ink-900"}`}>{msg.content}</div>
              </div>
            ))}
            {loading && <div className="flex justify-start"><div className="bg-ink-100 rounded-2xl px-4 py-2.5"><Loader2 className="w-4 h-4 animate-spin text-ink-400" /></div></div>}
          </div>
          <div className="flex gap-2 pt-4 border-t border-ink-100 mt-4">
            <input maxLength={4000} aria-label="Question about the video" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && onSend()} placeholder="Ask about the video..." className="input flex-1" disabled={loading} />
            <button aria-label="Send message" onClick={onSend} className="btn-primary" disabled={loading || !input.trim()}><Send className="w-4 h-4" /></button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTab({ summary, loading, type, setType, onRegenerate, hasTranscript }: {
  summary: string; loading: boolean; type: "brief" | "detailed" | "bullet" | "takeaways";
  setType: (t: "brief" | "detailed" | "bullet" | "takeaways") => void;
  onRegenerate: (type?: "brief" | "detailed" | "bullet" | "takeaways") => void;
  hasTranscript: boolean;
}) {
  const types = [
    { id: "brief" as const, label: "Brief", icon: FileText },
    { id: "detailed" as const, label: "Detailed", icon: List },
    { id: "bullet" as const, label: "Bullet Points", icon: List },
    { id: "takeaways" as const, label: "Key Takeaways", icon: Sparkles },
  ];
  return (
    <div>
      <div className="flex gap-2 mb-6 flex-wrap">
        {types.map((t) => (
          <button key={t.id} disabled={loading || !hasTranscript} onClick={() => { setType(t.id); if (type !== t.id) onRegenerate(t.id); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${type === t.id ? "bg-ink-900 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200"}`}>{t.label}</button>
        ))}
      </div>
      {hasTranscript && !loading && <button className="btn-secondary mb-4" onClick={() => onRegenerate(type)}>{summary ? "Regenerate summary" : "Generate summary"}</button>}
      {!hasTranscript && !loading && (
        <div className="card p-6 text-center">
          <FileText className="w-8 h-8 text-ink-300 mx-auto mb-3" />
          <p className="text-sm text-ink-400">A transcript is required to generate a summary.</p>
        </div>
      )}
      {loading && <div className="flex items-center gap-3 text-ink-400"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Generating summary...</span></div>}
      {!loading && summary && <div className="card p-6 animate-fade-in"><ExportText text={summary} filename="yt-studio-summary.txt" /><div dir="auto" className="whitespace-pre-wrap text-sm text-ink-700 leading-relaxed">{summary}</div></div>}
    </div>
  );
}

function ViralTab({ shorts, loading, onRegenerate, hasTranscript }: { shorts: ViralShort[]; loading: boolean; onRegenerate: () => void; hasTranscript: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-ink-500">AI-generated short-form content ideas from this video</p>
        <button disabled={loading || !hasTranscript} onClick={onRegenerate} className="btn-secondary text-xs">{shorts.length ? "Regenerate ideas" : "Generate ideas"}</button>
      </div>
      {!hasTranscript && <p className="text-sm text-ink-600">A transcript is required to generate clip ideas.</p>}
      <p className="text-xs text-ink-600 mb-4">Produces scripts and suggested timestamps. Video rendering and editing are not included; scores are AI estimates.</p>
      {loading && <div className="flex items-center gap-3 text-ink-400"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Finding viral moments...</span></div>}
      <div className="space-y-4">
        {shorts.map((short, i) => (
          <div key={i} className="card p-5 animate-slide-up" style={{ animationDelay: `${i * 100}ms` }}>
            <ExportText text={`${short.title}\n${formatTimestamp(short.startTime)} – ${formatTimestamp(short.endTime)}\n\nHook: ${short.hook}\n\n${short.script}\n\n${short.captions.join("\n")}\n\n${short.hashtags.join(" ")}\n\nThumbnail: ${short.thumbnailSuggestion}`} filename={`yt-studio-clip-${i + 1}.txt`} />
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-base">{short.title}</h3>
                <div className="flex items-center gap-3 mt-1 text-xs text-ink-400">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatTimestamp(short.startTime)} - {formatTimestamp(short.endTime)}</span>
                  <span className={`badge ${short.viralScore >= 80 ? "bg-green-50 text-green-600" : "bg-amber-50 text-amber-600"}`}>Viral score: {short.viralScore}/100</span>
                </div>
              </div>
            </div>
            <div className="space-y-3 mt-4">
              <div><p className="text-xs font-medium text-ink-400 mb-1">HOOK (first 3 seconds)</p><p className="text-sm font-medium bg-amber-50 p-2 rounded-lg">"{short.hook}"</p></div>
              <div><p className="text-xs font-medium text-ink-400 mb-1">SCRIPT</p><p className="text-sm text-ink-700 whitespace-pre-wrap">{short.script}</p></div>
              <div><p className="text-xs font-medium text-ink-400 mb-1">CAPTIONS</p><div className="flex flex-wrap gap-1">{short.captions.map((c, j) => <span key={j} className="badge bg-ink-100 text-ink-600">{c}</span>)}</div></div>
              <div><p className="text-xs font-medium text-ink-400 mb-1">HASHTAGS</p><div className="flex flex-wrap gap-1">{short.hashtags.map((h, j) => <span key={j} className="badge bg-blue-50 text-blue-600">{h}</span>)}</div></div>
              <div><p className="text-xs font-medium text-ink-400 mb-1">THUMBNAIL</p><p className="text-sm text-ink-600">{short.thumbnailSuggestion}</p></div>
              <div><p className="text-xs font-medium text-ink-400 mb-1">WHY VIRAL</p><p className="text-sm text-ink-600 italic">{short.reason}</p></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DownloadTab({ info, loading, onRetry }: { info: DownloadInfo | null; loading: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-ink-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Getting download options...</span>
      </div>
    );
  }
  if (!info) return <button className="btn-secondary" onClick={onRetry}>Retry download options</button>;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(info!.videoUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="max-w-2xl">
      {/* The download tools below need the video link pasted in, so make
          copying it one click instead of asking the user to retype it. */}
      <div className="card p-4 mb-4">
        <p className="text-xs font-medium text-ink-400 mb-2">VIDEO LINK</p>
        <div className="flex items-center gap-2">
          <input
            id="download-video-url"
            aria-label="Video link to copy"
            readOnly
            value={info.videoUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="input flex-1 font-mono text-xs"
          />
          <button onClick={copyLink} className="btn-secondary text-xs whitespace-nowrap">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {info.options?.map((opt, i) => (
          <a
            key={i}
            href={opt.url}
            target="_blank"
            rel="noopener noreferrer"
            className="card p-4 flex items-center justify-between hover:border-ink-300 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-ink-100 flex items-center justify-center">
                {opt.type === "external" ? (
                  <Play className="w-5 h-5 text-ink-600" />
                ) : (
                  <Download className="w-5 h-5 text-ink-600" />
                )}
              </div>
              <div>
                <p className="font-medium text-sm">{opt.label}</p>
                <p className="text-xs text-ink-400">{opt.desc}</p>
              </div>
            </div>
            <span className="text-ink-400 group-hover:text-ink-600 transition-colors">↗</span>
          </a>
        ))}
      </div>

      <div className="mt-6 p-4 bg-ink-50 rounded-xl space-y-2">
        <p className="text-xs text-ink-500">
          YT Studio cannot download the file itself — YouTube signs and encrypts its
          media URLs, so the download has to happen in a dedicated tool.
        </p>
        <p className="text-xs text-ink-400">
          💡 For educational use only — respect YouTube's Terms of Service and creator copyright.
        </p>
      </div>
    </div>
  );
}

// Timestamps come from formatTimestamp so every surface agrees, including
// past the one-hour mark.
