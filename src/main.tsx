import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loader } from "@monaco-editor/react";
import { AppRouter } from "./router";
import { Toaster } from "./components/ui/toast";
import "./index.css";

// Configure Monaco Editor to use local bundled version (avoid CDN issues)
loader.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs" } });

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
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <AppRouter />
    <Toaster />
  </QueryClientProvider>,
);
