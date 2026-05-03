/**
 * React Router Configuration
 *
 * Uses vite-plugin-pages for file-system based routing.
 * URL is the ONLY source of truth for navigation.
 */
import { Suspense } from "react";
import { createHashRouter, RouterProvider } from "react-router-dom";
import routes from "~react-pages";
import { LoadingState } from "./components/config";
import RootLayout from "./pages/_layout";

// ============================================================================
// Router Configuration
// ============================================================================

// Routes that bypass RootLayout — used by secondary windows (search overlay,
// future auxiliary panels) that render bare UI without the app shell.
const STANDALONE_PATHS = new Set(["/search-overlay", "/prompt-detail"]);
const standaloneRoutes = routes.filter((r) =>
  r && typeof r === "object" && "path" in r && STANDALONE_PATHS.has(`/${(r as { path?: string }).path ?? ""}`)
);
const layoutRoutes = routes.filter((r) => !standaloneRoutes.includes(r));

const routesWithLayout = [
  ...standaloneRoutes,
  {
    path: "/",
    element: <RootLayout />,
    children: layoutRoutes,
  },
];

const router = createHashRouter(routesWithLayout);

// ============================================================================
// Router Provider
// ============================================================================

export function AppRouter() {
  return (
    <Suspense fallback={<LoadingState message="Loading app…" />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}

// ============================================================================
// Re-exports for navigation
// ============================================================================

export { useNavigate, useLocation, useParams, useSearchParams } from "react-router-dom";
