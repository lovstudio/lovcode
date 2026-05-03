import ReactDOM from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { AppRouter } from "./router";
import { Toaster } from "./components/ui/toast";
import "./index.css";

// Disable browser context menu in production (no reload/inspect-element).
// Radix ContextMenu triggers fire their own onContextMenu BEFORE this listener
// (capture=false, registered later, but Radix uses `onContextMenu` JSX prop on
// trigger which dispatches first up the React tree). Our PathLink stops propagation
// so the document-level handler still runs but harmlessly preventDefault's the
// already-handled native menu. The Radix menu remains open.
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached entries hydrate from localStorage instantly (gcTime keeps them
      // in memory + persister mirrors them to disk). Fresh fetch still runs
      // in the background — see PERSIST_KEYS below.
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60 * 24 * 7, // 7 days — persister needs gcTime > 0
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

// Sessions stream in via useStreamedSessions (first batch in ~200ms), so we
// no longer mirror them to localStorage — the sync JSON.parse on reload was
// blocking the main thread for hundreds of ms with 1500+ sessions.
// projects is small (~100 entries) so still worth persisting for instant paint.
const PERSIST_KEYS: ReadonlyArray<string> = ["projects"];

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: "lovcode:rq-cache",
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{
      persister,
      maxAge: 1000 * 60 * 60 * 24 * 7,
      dehydrateOptions: {
        // Only mirror the listed query keys to localStorage.
        shouldDehydrateQuery: (q) =>
          q.state.status === "success" &&
          Array.isArray(q.queryKey) &&
          typeof q.queryKey[0] === "string" &&
          PERSIST_KEYS.includes(q.queryKey[0] as string),
      },
    }}
    onSuccess={() => {
      PERSIST_KEYS.forEach((key) => {
        queryClient.refetchQueries({ queryKey: [key] });
      });
    }}
  >
    <AppRouter />
    <Toaster />
  </PersistQueryClientProvider>,
);

// Splash fade-out is triggered explicitly by the first layout that mounts
// (RootLayout / standalone pages dispatch "app:ready"). This avoids the
// flash of "Loading app…" between the splash and the real shell.
window.addEventListener("app:ready", () => {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("fade");
  splash.addEventListener("transitionend", () => splash.remove(), { once: true });
}, { once: true });

// Safety net: if no layout reports ready within 8s (e.g. unexpected error
// boundary), drop the splash anyway so the user isn't stuck staring at it.
setTimeout(() => window.dispatchEvent(new Event("app:ready")), 8000);
