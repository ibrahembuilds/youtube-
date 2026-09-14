import { Routes, Route, Link } from "react-router-dom";
import Studio from "./pages/Studio";
import Landing from "./pages/Landing";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/studio" element={<Studio />} />
      <Route path="*" element={<main className="max-w-xl mx-auto px-6 py-24 text-center"><p className="text-sm text-ink-600">404</p><h1 className="text-3xl font-semibold mt-3 mb-4">Page not found</h1><p className="text-ink-600 mb-8">This address does not exist. Open the studio to start with a video.</p><Link to="/studio" className="btn-primary">Open studio</Link></main>} />
    </Routes>
  );
}
