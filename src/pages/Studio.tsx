import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Play, Sparkles, MessageCircle, Download, Scissors, Loader2, Send, FileText, List, CheckCircle, Clock, Globe, Languages } from "lucide-react";
import { extractVideoId, getEmbedUrl, getThumbnail, fetchVideoInfo, type VideoInfo } from "@/lib/youtube";
import {
  fetchTranscriptMeta, fetchAllTranscriptContent, fetchTranscriptContent,
  translateTranscript, chatWithVideo, generateSummary, generateViralShorts,
  getDownloadInfo, formatTranscriptText, TranscriptLookupError,
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

export default function Studio() {
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
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
  const selectedSegments = trackSegments.get(selectedTrackIndex) || [];
  const selectedTrack = transcriptMeta?.tracks?.[selectedTrackIndex] ?? null;
  const transcriptText = formatTranscriptText(selectedSegments);

  const trackCode = selectedTrack?.languageCode;

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

  async function handleLoad() {
    setError("");
    setErrorIsRetryable(false);
    const id = extractVideoId(url);
    if (!id) { setError("Please enter a valid YouTube URL"); return; }

    setLoading(true);
    setVideoId(id);
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

    if (infoResult.status === "fulfilled") setVideoInfo(infoResult.value);

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
      const newMap = new Map<number, TranscriptSegment[]>();
      allSegments.forEach((segs, i) => {
        if (segs) newMap.set(i, segs);
      });
      setTrackSegments(newMap);
    } finally {
      setLoading(false);
      setLoadingTranscript(false);
    }
  }

  async function handleSwitchTrack(index: number) {
    setSelectedTrackIndex(index);
    setTranslatedText("");

    // If we haven't loaded this track's segments yet, fetch them now (browser-side)
    if (!trackSegments.has(index) && transcriptMeta?.tracks[index]) {
      try {
        const segs = await fetchTranscriptContent(transcriptMeta.tracks[index]);
        setTrackSegments((prev) => {
          const next = new Map(prev);
          next.set(index, segs);
          return next;
        });
      } catch {
        // silently fail — segments just stay empty for this track
      }
    }
  }

  async function handleTranslate() {
    if (!selectedSegments.length || translating) return;
    setTranslating(true);
    setTranslatedText("");
    try {
      const result = await translateTranscript(selectedSegments, targetLanguage);
      setTranslatedText(result);
    } catch (err: any) {
      setError(err.message || "Translation failed");
    } finally {
      setTranslating(false);
    }
  }

  async function handleChat() {
    if (!chatInput.trim() || chatLoading || !transcriptText) return;
    const userMsg: ChatMessage = { role: "user", content: chatInput };
    const newMessages = [...chatMessages, userMsg];
    setChatMessages(newMessages);
    setChatInput("");
    setChatLoading(true);
    try {
      const response = await chatWithVideo(videoId!, newMessages, transcriptText);
      setChatMessages([...newMessages, { role: "assistant", content: response }]);
    } catch (err: any) {
      setChatMessages([...newMessages, { role: "assistant", content: `Error: ${err.message}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function handleSummary() {
    if (summaryLoading || !transcriptText) return;
    setSummaryLoading(true);
    setSummary("");
    try {
      const result = await generateSummary(videoId!, transcriptText, summaryType);
      setSummary(result);
    } catch (err: any) {
      setSummary(`Error: ${err.message}`);
    } finally {
      setSummaryLoading(false);
    }
  }

  async function handleViral() {
    if (viralLoading || !transcriptText) return;
    setViralLoading(true);
    setShorts([]);
    try {
      const result = await generateViralShorts(videoId!, transcriptText);
      setShorts(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setViralLoading(false);
    }
  }

  async function handleDownload() {
    if (downloadLoading) return;
    setDownloadLoading(true);
    try {
      const info = await getDownloadInfo(videoId!);
      setDownloadInfo(info);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDownloadLoading(false);
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
    <div className="min-h-screen bg-white">
      <header className="border-b border-ink-100 sticky top-0 z-10 bg-white/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-ink-900 flex items-center justify-center">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-semibold">YT Studio</span>
          </Link>
          <div className="flex items-center gap-3">
            {transcriptMeta && (
              <div className="badge bg-green-50 text-green-600">
                <CheckCircle className="w-3 h-3" />
                {transcriptMeta.totalTracks} language{transcriptMeta.totalTracks !== 1 ? "s" : ""}
                {loadingTranscript && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* URL Input */}
        <div className="mb-8">
          <div className="flex gap-3">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLoad()}
              placeholder="Paste YouTube link here..."
              className="input flex-1"
              disabled={loading}
            />
            <button onClick={handleLoad} className="btn-primary whitespace-nowrap" disabled={loading || !url}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load Video"}
            </button>
          </div>
          {error && (
            <div className="mt-3 flex items-start gap-3">
              <p className="text-sm text-red-500">{error}</p>
              {errorIsRetryable && (
                <button
                  onClick={handleLoad}
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

            <div className="flex gap-1 mb-6 border-b border-ink-100 overflow-x-auto">
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
              {activeTab === "watch" && <WatchTab videoId={videoId} videoInfo={videoInfo} selectedTrack={selectedTrack} segmentCount={selectedSegments.length} />}
              {activeTab === "transcript" && (
                <TranscriptTab
                  segments={selectedSegments}
                  track={selectedTrack}
                  loading={loadingTranscript}
                  translatedText={translatedText}
                  targetLanguage={targetLanguage}
                  setTargetLanguage={setTargetLanguage}
                  onTranslate={handleTranslate}
                  translating={translating}
                  targetIsSameLanguage={targetIsSameLanguage}
                  onClearTranslation={() => setTranslatedText("")}
                />
              )}
              {activeTab === "chat" && (
                <ChatTab messages={chatMessages} input={chatInput} setInput={setChatInput} onSend={handleChat} loading={chatLoading} hasTranscript={!!selectedTrack} />
              )}
              {activeTab === "summary" && (
                <SummaryTab summary={summary} loading={summaryLoading} type={summaryType} setType={setSummaryType} onRegenerate={handleSummary} />
              )}
              {activeTab === "viral" && (
                <ViralTab shorts={shorts} loading={viralLoading} onRegenerate={handleViral} />
              )}
              {activeTab === "download" && (
                <DownloadTab info={downloadInfo} loading={downloadLoading} />
              )}
            </div>
          </div>
        )}

        {!videoId && !loading && (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-2xl bg-ink-100 flex items-center justify-center mx-auto mb-4">
              <Play className="w-7 h-7 text-ink-400" />
            </div>
            <p className="text-ink-400">Paste a YouTube link above to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab Components ──────────────────────────────────────────────────

function WatchTab({ videoId, videoInfo, selectedTrack, segmentCount }: {
  videoId: string; videoInfo: VideoInfo | null; selectedTrack: TranscriptTrack | null; segmentCount: number;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        <div className="aspect-video rounded-2xl overflow-hidden bg-ink-900">
          <iframe src={getEmbedUrl(videoId)} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
        </div>
      </div>
      <div>
        {videoInfo && (
          <div className="card p-4 mb-4">
            <img src={getThumbnail(videoId, "mq")} alt={videoInfo.title} className="w-full rounded-lg mb-3" />
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
              <div className="flex justify-between"><span>Segments</span><span className="font-medium text-ink-700">{segmentCount || "Loading..."}</span></div>
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
}: {
  segments: TranscriptSegment[]; track: TranscriptTrack | null; loading: boolean;
  translatedText: string; targetLanguage: string; setTargetLanguage: (v: string) => void;
  onTranslate: () => void; translating: boolean; onClearTranslation: () => void;
  targetIsSameLanguage: boolean;
}) {
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
        <div className="max-h-[600px] overflow-y-auto">
          <div className="whitespace-pre-wrap text-sm text-ink-700 leading-relaxed font-mono">
            {translatedText || segments.map((s) => {
              const m = Math.floor(s.start / 60);
              const sec = Math.floor(s.start % 60);
              return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
            }).join("\n")}
          </div>
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
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSend()} placeholder="Ask about the video..." className="input flex-1" disabled={loading} />
            <button onClick={onSend} className="btn-primary" disabled={loading || !input.trim()}><Send className="w-4 h-4" /></button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTab({ summary, loading, type, setType, onRegenerate }: {
  summary: string; loading: boolean; type: "brief" | "detailed" | "bullet" | "takeaways";
  setType: (t: "brief" | "detailed" | "bullet" | "takeaways") => void; onRegenerate: () => void;
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
          <button key={t.id} onClick={() => { setType(t.id); if (type !== t.id) onRegenerate(); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${type === t.id ? "bg-ink-900 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200"}`}>{t.label}</button>
        ))}
      </div>
      {loading && <div className="flex items-center gap-3 text-ink-400"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Generating summary...</span></div>}
      {!loading && summary && <div className="card p-6 animate-fade-in"><div className="whitespace-pre-wrap text-sm text-ink-700 leading-relaxed">{summary}</div></div>}
    </div>
  );
}

function ViralTab({ shorts, loading, onRegenerate }: { shorts: ViralShort[]; loading: boolean; onRegenerate: () => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-ink-500">AI-generated short-form content ideas from this video</p>
        {shorts.length > 0 && <button onClick={onRegenerate} className="btn-ghost text-xs">↻ Regenerate</button>}
      </div>
      {loading && <div className="flex items-center gap-3 text-ink-400"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Finding viral moments...</span></div>}
      <div className="space-y-4">
        {shorts.map((short, i) => (
          <div key={i} className="card p-5 animate-slide-up" style={{ animationDelay: `${i * 100}ms` }}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-base">{short.title}</h3>
                <div className="flex items-center gap-3 mt-1 text-xs text-ink-400">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmt(short.startTime)} - {fmt(short.endTime)}</span>
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

function DownloadTab({ info, loading }: { info: DownloadInfo | null; loading: boolean }) {
  const [copied, setCopied] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-ink-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Getting download options...</span>
      </div>
    );
  }
  if (!info) return null;

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

function fmt(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
