import { Link } from "react-router-dom";
import {
  Play, Sparkles, MessageCircle, Scissors, FileText, Languages,
  Link2, MousePointerClick, Zap, ArrowRight, ChevronDown, Clock, Bookmark,
} from "lucide-react";

const FEATURES = [
  { icon: Bookmark, title: "History & saved videos", desc: "Return to your last 100 videos, search by title or channel, and bookmark your favorites in this browser.", color: "bg-ink-100 text-ink-700" },
  { icon: FileText, title: "Searchable transcripts", desc: "Read available YouTube captions, click timestamps to seek, and copy or download the full text.", color: "bg-blue-50 text-blue-600" },
  { icon: Languages, title: "19-language translation", desc: "Translate any transcript into Spanish, Arabic, Japanese, Hindi and 15 more.", color: "bg-purple-50 text-purple-600" },
  { icon: MessageCircle, title: "Chat with the video", desc: "Ask anything and get answers grounded in exactly what was said, with timestamps.", color: "bg-green-50 text-green-600" },
  { icon: Sparkles, title: "Instant summaries", desc: "Brief, detailed, bullet-point, or key-takeaway summaries generated in seconds.", color: "bg-amber-50 text-amber-600" },
  { icon: Scissors, title: "Short-form clip ideas", desc: "Get suggested moments, hooks, scripts, captions, and hashtags. Export the text to use in your editor.", color: "bg-rose-50 text-rose-600" },
];

const STEPS = [
  { icon: Link2, title: "Paste a YouTube link", desc: "Drop in any public video URL — no upload, no sign-up." },
  { icon: MousePointerClick, title: "Pick a tool", desc: "Chat, summarize, translate, or generate viral shorts from the tabs." },
  { icon: Zap, title: "Get results instantly", desc: "AI reads the transcript and hands you exactly what you asked for." },
];

const FAQS = [
  { q: "Do I need to create an account?", a: "No account is needed. Video history and bookmarks are saved in this browser; AI requests are processed by the server. Clearing browser data removes your history. It does not sync across devices." },
  { q: "Which languages are supported?", a: "Transcripts can be translated into 19 languages, including Spanish, Arabic, Hindi, Japanese, Korean, Portuguese, and more." },
  { q: "Does this work on videos without captions?", a: "Chat, summaries, translation, and clip ideas require captions. YouTube restrictions or rate limits can prevent access. Watching depends on whether the creator allows embedded playback." },
  { q: "Can I download the results?", a: "Yes — transcripts, translations, summaries, and clip scripts can be downloaded as text. Finished video clips are not rendered here. Video and audio downloads use external tools; only download content you have permission to use." },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      {/* Nav */}
      <nav className="border-b border-ink-100 sticky top-0 z-20 bg-white/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-ink-900 flex items-center justify-center">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-semibold text-lg">YT Studio</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-ink-600">
            <a href="#features" className="hover:text-ink-900 transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-ink-900 transition-colors">How it works</a>
            <a href="#faq" className="hover:text-ink-900 transition-colors">FAQ</a>
          </div>
          <Link to="/studio" className="btn-primary text-sm">
            Open studio →
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 -top-24 flex justify-center">
          <div className="w-[640px] h-[640px] rounded-full bg-gradient-to-br from-ink-100 via-blue-50 to-transparent blur-3xl opacity-70" />
        </div>
        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
          <div className="badge bg-ink-100 text-ink-600 mb-6 animate-fade-in">
            <Sparkles className="w-3 h-3" />
            Your video workspace — no account needed
          </div>
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-[1.1] animate-slide-up">
            One link. Every insight
            <br />
            <span className="text-ink-400">from any YouTube video.</span>
          </h1>
          <p className="text-lg text-ink-500 mb-8 max-w-2xl mx-auto animate-slide-up">
            Paste a YouTube URL and chat with it like ChatGPT, pull instant AI summaries,
            translate transcripts, and plan your next short-form clip.
            Keep your favorite videos close with local history and bookmarks.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
            <Link to="/studio" className="btn-primary text-base px-8 py-3 w-full sm:w-auto">
              Get started
            </Link>
            <a href="#how-it-works" className="btn-secondary text-base px-8 py-3 w-full sm:w-auto">
              See how it works
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-ink-400">
            <span>No sign-up</span>
            <span className="w-1 h-1 rounded-full bg-ink-300" />
            <span>No credit card</span>
            <span className="w-1 h-1 rounded-full bg-ink-300" />
            <span>Local video history</span>
          </div>
        </div>
      </div>

      {/* Product preview */}
      <div className="max-w-5xl mx-auto px-6 pb-24">
        <div className="card overflow-hidden shadow-xl shadow-ink-100">
          <div className="flex items-center gap-1.5 px-4 py-3 border-b border-ink-100 bg-ink-50">
            <span className="w-3 h-3 rounded-full bg-ink-200" />
            <span className="w-3 h-3 rounded-full bg-ink-200" />
            <span className="w-3 h-3 rounded-full bg-ink-200" />
            <span className="ml-3 text-xs text-ink-400 font-mono truncate">YT Studio · Illustrative preview</span>
          </div>
          <div className="flex gap-1 px-4 pt-4 border-b border-ink-100 overflow-x-auto">
            {["Watch", "Transcript", "Chat", "Summary", "Viral Shorts", "Download"].map((tab, i) => (
              <span
                key={tab}
                className={`px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap ${
                  i === 2 ? "border-ink-900 text-ink-900" : "border-transparent text-ink-400"
                }`}
              >
                {tab}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6 bg-white">
            <div className="space-y-3">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-ink-900 text-white">
                  What's the key takeaway from this video?
                </div>
              </div>
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-2xl px-4 py-2.5 text-sm bg-ink-100 text-ink-900">
                  At 2:14 the host explains the core framework — three steps to
                  validate an idea before building it.
                </div>
              </div>
            </div>
            <div className="card p-4 bg-ink-50/50">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">Hook, 0:42 – 1:10</h3>
                <span className="badge bg-green-50 text-green-600 text-xs">Example clip idea</span>
              </div>
              <p className="text-xs text-ink-400 mb-2 flex items-center gap-1"><Clock className="w-3 h-3" />28s clip</p>
              <p className="text-sm bg-amber-50 rounded-lg p-2 mb-2">"This one mistake is costing you customers..."</p>
              <div className="flex flex-wrap gap-1">
                {["#startup", "#growth", "#productivity"].map((h) => (
                  <span key={h} className="badge bg-blue-50 text-blue-600">{h}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Features */}
      <div id="features" className="max-w-5xl mx-auto px-6 pb-24 scroll-mt-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">Everything you need, in one tab</h2>
          <p className="text-ink-500 max-w-xl mx-auto">No juggling five different tools — YT Studio replaces all of them.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f, i) => (
            <div key={i} className="card p-6 hover:border-ink-300 hover:shadow-md transition-all">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${f.color}`}>
                <f.icon className="w-5 h-5" />
              </div>
              <h3 className="font-semibold text-sm mb-1.5">{f.title}</h3>
              <p className="text-sm text-ink-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* How it works */}
      <div id="how-it-works" className="border-y border-ink-100 bg-ink-50/50 scroll-mt-20">
        <div className="max-w-5xl mx-auto px-6 py-24">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold tracking-tight mb-3">How it works</h2>
            <p className="text-ink-500">Three steps. No learning curve.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {STEPS.map((s, i) => (
              <div key={i} className="relative text-center">
                <div className="w-12 h-12 rounded-2xl bg-ink-900 text-white flex items-center justify-center mx-auto mb-4">
                  <s.icon className="w-5 h-5" />
                </div>
                <div className="text-xs font-mono text-ink-400 mb-1">Step {i + 1}</div>
                <h3 className="font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-ink-500 leading-relaxed max-w-xs mx-auto">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div id="faq" className="max-w-3xl mx-auto px-6 py-24 scroll-mt-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold tracking-tight mb-3">Frequently asked questions</h2>
        </div>
        <div className="space-y-3">
          {FAQS.map((f, i) => (
            <details key={i} className="card p-5 group">
              <summary className="flex items-center justify-between cursor-pointer list-none font-medium text-sm">
                {f.q}
                <ChevronDown className="w-4 h-4 text-ink-400 transition-transform group-open:rotate-180 shrink-0 ml-4" />
              </summary>
              <p className="text-sm text-ink-500 mt-3 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </div>

      {/* Closing CTA */}
      <div className="max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-3xl bg-ink-900 text-white px-8 py-16 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            Ready to get more out of every video?
          </h2>
          <p className="text-ink-300 mb-8 max-w-lg mx-auto">
            A place to watch, understand, and return to the videos that matter.
          </p>
          <Link to="/studio" className="inline-flex items-center gap-2 bg-white text-ink-900 font-medium text-base px-8 py-3 rounded-lg hover:bg-ink-100 transition-all active:scale-[0.98]">
            Open your workspace
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-ink-100">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-ink-400">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-ink-900 flex items-center justify-center">
              <Play className="w-3 h-3 text-white fill-white" />
            </div>
            <span className="font-medium text-ink-600">YT Studio</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#features" className="hover:text-ink-600 transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-ink-600 transition-colors">How it works</a>
            <Link to="/studio" className="hover:text-ink-600 transition-colors">Studio</Link>
          </div>
          <span>Powered by AI · Educational use only</span>
        </div>
      </footer>
    </div>
  );
}
