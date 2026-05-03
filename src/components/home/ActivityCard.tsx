import type { Project } from "../../types";
import { useInvokeQuery, useSessionsCache } from "../../hooks";
import { ActivityHeatmap } from "./ActivityHeatmap";

/**
 * Activity heatmap card with workspace / session / message stats.
 *
 * Used as an empty-state placeholder across the app (PanelGrid, ProjectList,
 * etc.) to give the user something useful to look at while no specific item
 * is selected.
 */
export function ActivityCard({ className = "" }: { className?: string }) {
  const { data: projects = [] } = useInvokeQuery<Project[]>(["projects"], "list_projects");
  const sessions = useSessionsCache();
  const { data: stats } = useInvokeQuery<{
    daily: Record<string, number>;
    hourly: Record<string, number>;
    detailed: Record<string, number>;
  }>(["activityStats"], "get_activity_stats");

  if (!stats) return null;
  const totalRounds = sessions.reduce((sum, s) => sum + s.rounds, 0);

  return (
    <div className={`w-full shrink-0 bg-card/50 rounded-2xl p-3 border border-border/40 overflow-hidden ${className}`}>
      <ActivityHeatmap daily={stats.daily} detailed={stats.detailed} />
      <div className="flex items-center gap-6 mt-2 pt-2 border-t border-border/40 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground font-serif">{projects.length}</strong> workspaces
        </span>
        <span>
          <strong className="text-foreground font-serif">{sessions.length}</strong> sessions
        </span>
        <span>
          <strong className="text-foreground font-serif">{totalRounds}</strong> rounds
        </span>
      </div>
    </div>
  );
}
