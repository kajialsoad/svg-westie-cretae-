import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Upload, Trash2, Plus, Loader2, BarChart3, Boxes, HelpCircle } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Header } from "../components/Header";
import { SvgaCanvas } from "../components/SvgaCanvas";
import { useAuth } from "../context/AuthContext";
import { api, API, apiErr } from "../lib/api";
import { toast } from "sonner";

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-5">
      <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">{label}</p>
      <p data-testid={`stat-${label.toLowerCase().replace(/ /g, "-")}`} className="font-mono text-3xl font-medium mt-2">{value ?? 0}</p>
    </div>
  );
}

export default function Admin() {
  const { user, loading, logout } = useAuth();
  const nav = useNavigate();
  const [stats, setStats] = useState({});
  const [items, setItems] = useState([]);
  const [faqs, setFaqs] = useState([]);

  // showcase upload form
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("general");
  const [uploading, setUploading] = useState(false);

  // faq form
  const [q, setQ] = useState("");
  const [a, setA] = useState("");

  useEffect(() => {
    if (!loading && !user) nav("/login");
  }, [loading, user]); // eslint-disable-line

  const load = () => {
    api.get("/admin/stats").then((r) => setStats(r.data)).catch(() => {});
    api.get("/showcase").then((r) => setItems(r.data)).catch(() => {});
    api.get("/faq").then((r) => setFaqs(r.data)).catch(() => {});
  };
  useEffect(() => { if (user) load(); }, [user]); // eslint-disable-line

  if (loading || !user) {
    return <div className="min-h-screen bg-[#050505] grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>;
  }

  const uploadShowcase = async (e) => {
    e.preventDefault();
    if (!file || !title) { toast.error("File and title required"); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file); fd.append("title", title); fd.append("description", desc); fd.append("category", category);
    try {
      await api.post("/admin/showcase", fd);
      toast.success("Animation added to showcase");
      setFile(null); setTitle(""); setDesc("");
      load();
    } catch (err) { toast.error(apiErr(err)); } finally { setUploading(false); }
  };

  const delShowcase = async (id) => {
    try { await api.delete(`/admin/showcase/${id}`); setItems((p) => p.filter((x) => x.id !== id)); toast.success("Removed"); }
    catch (e) { toast.error(apiErr(e)); }
  };

  const addFaq = async (e) => {
    e.preventDefault();
    if (!q || !a) { toast.error("Question and answer required"); return; }
    try { await api.post("/admin/faq", { question: q, answer: a, order: faqs.length }); setQ(""); setA(""); load(); toast.success("FAQ added"); }
    catch (err) { toast.error(apiErr(err)); }
  };

  const delFaq = async (id) => {
    try { await api.delete(`/admin/faq/${id}`); setFaqs((p) => p.filter((x) => x.id !== id)); toast.success("Deleted"); }
    catch (e) { toast.error(apiErr(e)); }
  };

  const input = "w-full bg-[#050505] border border-zinc-800 focus:border-blue-500 rounded-md px-3 py-2.5 text-sm outline-none";

  return (
    <div className="min-h-screen bg-[#050505]">
      <Header />
      <div className="max-w-7xl mx-auto px-5 md:px-8 py-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Admin dashboard</h1>
            <p className="text-zinc-500 text-sm mt-1">Signed in as <span className="font-mono text-zinc-400">{user.email}</span></p>
          </div>
          <button data-testid="logout-btn" onClick={() => { logout(); nav("/"); }}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-700 hover:bg-zinc-900 px-4 py-2 text-sm font-medium transition-colors">
            <LogOut className="h-4 w-4" /> Logout
          </button>
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="bg-[#0A0A0A] border border-zinc-800/80">
            <TabsTrigger value="overview" data-testid="tab-overview"><BarChart3 className="h-4 w-4 mr-2" />Overview</TabsTrigger>
            <TabsTrigger value="showcase" data-testid="tab-showcase"><Boxes className="h-4 w-4 mr-2" />Showcase</TabsTrigger>
            <TabsTrigger value="faq" data-testid="tab-faq"><HelpCircle className="h-4 w-4 mr-2" />FAQ</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Stat label="Previews" value={stats.previews} />
              <Stat label="Conversions" value={stats.conversions} />
              <Stat label="Showcase Items" value={stats.showcase_count} />
              <Stat label="Showcase Views" value={stats.showcase_views} />
              <Stat label="Users" value={stats.users} />
              <Stat label="FAQ Entries" value={stats.faq_count} />
            </div>
            {stats.conversion_breakdown && Object.keys(stats.conversion_breakdown).length > 0 && (
              <div className="mt-6 rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-5">
                <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500 mb-4">Conversions by type</p>
                <div className="grid sm:grid-cols-3 gap-3">
                  {Object.entries(stats.conversion_breakdown).map(([k, v]) => (
                    <div key={k} className="flex justify-between border border-zinc-800 rounded-md px-3 py-2 text-sm">
                      <span className="font-mono text-zinc-400">{k.replace("convert_", "").replace(/_/g, "→")}</span>
                      <span className="font-mono text-white">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="showcase" className="mt-6">
            <div className="grid lg:grid-cols-3 gap-6">
              <form onSubmit={uploadShowcase} className="lg:col-span-1 rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-5 space-y-3 h-fit">
                <h3 className="font-display font-medium tracking-tight">Add animation</h3>
                <input data-testid="showcase-file-input" type="file" accept=".svga" onChange={(e) => setFile(e.target.files?.[0])} className={input + " file:text-zinc-400 file:bg-transparent file:border-0"} />
                <input data-testid="showcase-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={input} />
                <input data-testid="showcase-category-input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className={input} />
                <textarea data-testid="showcase-desc-input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" rows={3} className={input} />
                <button data-testid="showcase-upload-btn" disabled={uploading}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2.5 font-medium transition-colors">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
                </button>
              </form>

              <div className="lg:col-span-2 grid sm:grid-cols-2 gap-4" data-testid="admin-showcase-list">
                {items.length === 0 && <p className="text-zinc-500 text-sm">No items yet.</p>}
                {items.map((it) => (
                  <div key={it.id} className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] overflow-hidden">
                    <div className="checker h-40 grid place-items-center p-3">
                      <SvgaCanvas src={`${API}/showcase/${it.id}/file`} className="w-full h-full block" />
                    </div>
                    <div className="p-3 flex items-center justify-between border-t border-zinc-800/80">
                      <span className="text-sm font-medium truncate">{it.title}</span>
                      <button data-testid={`delete-showcase-${it.id}`} onClick={() => delShowcase(it.id)} className="text-zinc-500 hover:text-red-500 transition-colors">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="faq" className="mt-6">
            <div className="grid lg:grid-cols-3 gap-6">
              <form onSubmit={addFaq} className="lg:col-span-1 rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-5 space-y-3 h-fit">
                <h3 className="font-display font-medium tracking-tight">Add FAQ</h3>
                <input data-testid="faq-question-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Question" className={input} />
                <textarea data-testid="faq-answer-input" value={a} onChange={(e) => setA(e.target.value)} placeholder="Answer" rows={4} className={input} />
                <button data-testid="faq-add-btn" className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white py-2.5 font-medium transition-colors">
                  <Plus className="h-4 w-4" /> Add FAQ
                </button>
              </form>
              <div className="lg:col-span-2 space-y-3" data-testid="admin-faq-list">
                {faqs.length === 0 && <p className="text-zinc-500 text-sm">No FAQs yet. Defaults are shown on the homepage until you add some.</p>}
                {faqs.map((f) => (
                  <div key={f.id} className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-4 flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium">{f.question}</p>
                      <p className="text-sm text-zinc-500 mt-1">{f.answer}</p>
                    </div>
                    <button data-testid={`delete-faq-${f.id}`} onClick={() => delFaq(f.id)} className="text-zinc-500 hover:text-red-500 transition-colors shrink-0">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
