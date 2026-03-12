import { Routes, Route, NavLink } from "react-router-dom";
import Accounts from "./pages/Accounts";
import Audits from "./pages/Audits";
import AuditDetail from "./pages/AuditDetail";

function App() {
  return (
    <div className="min-h-screen">
      <nav className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center gap-8">
          <h1 className="text-xl font-bold text-gray-800">AWS Cost Saver</h1>
          <div className="flex gap-4">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `px-3 py-1 rounded text-sm font-medium ${isActive ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:text-gray-900"}`
              }
            >
              Accounts
            </NavLink>
            <NavLink
              to="/audits"
              className={({ isActive }) =>
                `px-3 py-1 rounded text-sm font-medium ${isActive ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:text-gray-900"}`
              }
            >
              Audits
            </NavLink>
          </div>
        </div>
      </nav>
      <main className="max-w-6xl mx-auto px-6 py-8">
        <Routes>
          <Route path="/" element={<Accounts />} />
          <Route path="/audits" element={<Audits />} />
          <Route path="/audits/:id" element={<AuditDetail />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
