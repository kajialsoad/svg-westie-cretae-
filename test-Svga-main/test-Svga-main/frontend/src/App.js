import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "./context/AuthContext";
import Home from "./pages/Home";
import Showcase from "./pages/Showcase";
import RemoveBg from "./pages/RemoveBg";
import LayerEditor from "./pages/LayerEditor";
import Login from "./pages/Login";
import Admin from "./pages/Admin";

const getBasename = () => {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/tanvir-svga")) {
    return "/tanvir-svga";
  }
  return process.env.PUBLIC_URL || "";
};

function App() {
  return (
    <div className="App">
      <AuthProvider>
        <BrowserRouter basename={getBasename()}>
          <Toaster theme="dark" position="top-center" richColors />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/showcase" element={<Showcase />} />
            <Route path="/remove-bg" element={<RemoveBg />} />
            <Route path="/editor" element={<LayerEditor />} />
            <Route path="/login" element={<Login />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}

export default App;
