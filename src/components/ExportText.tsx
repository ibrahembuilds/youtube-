import { useState } from "react";
import { Copy, Download, Check } from "lucide-react";

export default function ExportText({ text, filename = "yt-studio-notes.txt", downloadLabel = "Download text" }: { text: string; filename?: string; downloadLabel?: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus("Copied"); }
    catch { setStatus("Copy unavailable. Download the text instead."); }
  }
  function download() {
    // A leading BOM keeps Arabic and other scripts readable when the file is opened in Notepad.
    const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    setStatus("Saved");
    setTimeout(() => { URL.revokeObjectURL(url); setStatus(""); }, 2000);
  }
  return <div className="export-controls"><button className="btn-ghost" onClick={copy}>{status === "Copied" ? <Check size={14} /> : <Copy size={14} />} Copy text</button><button className="btn-ghost" onClick={download}><Download size={14} /> {downloadLabel}</button><span role="status">{status}</span></div>;
}
