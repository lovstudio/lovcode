import { Navigate } from "react-router-dom";

const LAST_PATH_KEY = "lovcode:lastPath";

function getLastPath(): string {
  try {
    const saved = localStorage.getItem(LAST_PATH_KEY);
    if (saved && saved !== "/" && saved.startsWith("/") && saved !== "/annual-report-2025") return saved;
  } catch {}
  return "/workspace";
}

export default function HomePage() {
  return <Navigate to={getLastPath()} replace />;
}
