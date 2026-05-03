import { Navigate } from "react-router-dom";

const LAST_PATH_KEY = "lovcode:lastPath";

// Routes that no longer exist (workspace removed; /chat renamed to /history)
function migrateLegacyPath(path: string): string {
  if (path === "/workspace" || path.startsWith("/workspace/")) return "/history";
  if (path === "/settings/llm") return "/settings/maas";
  if (path === "/chat" || path.startsWith("/chat/")) return path.replace(/^\/chat/, "/history");
  return path;
}

function getLastPath(): string {
  try {
    const saved = localStorage.getItem(LAST_PATH_KEY);
    if (saved && saved !== "/" && saved.startsWith("/") && saved !== "/annual-report-2025") {
      return migrateLegacyPath(saved);
    }
  } catch {}
  return "/history";
}

export default function HomePage() {
  return <Navigate to={getLastPath()} replace />;
}
