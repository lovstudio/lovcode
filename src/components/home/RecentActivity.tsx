import { FolderOpen, MessageSquare } from "lucide-react";
import type { Project, Session } from "../../types";
import { useReadableText } from "../../views/Chat/utils";

type ActivityItem =
  | { type: "project"; data: Project }
  | { type: "session"; data: Session };

interface RecentActivityProps {
  projects: Project[];
  sessions: Session[];
  onProjectClick: (project: Project) => void;
  onSessionClick: (session: Session) => void;
  maxItems?: number;
}

export function RecentActivity({
  projects,
  sessions,
  onProjectClick,
  onSessionClick,
  maxItems = 5,
}: RecentActivityProps) {
  const toReadable = useReadableText();

  // Merge and sort by last_modified
  const activities: ActivityItem[] = [
    ...projects.map((p) => ({ type: "project" as const, data: p })),
    ...sessions.map((s) => ({ type: "session" as const, data: s })),
  ]
    .sort((a, b) => {
      const timeA = a.type === "project" ? a.data.last_active : a.data.last_modified;
      const timeB = b.type === "project" ? b.data.last_active : b.data.last_modified;
      return timeB - timeA;
    })
    .slice(0, maxItems);

  const formatTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp * 1000;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  const getProjectName = (path: string): string => {
    return path.split("/").pop() || path;
  };

  if (activities.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No recent activity
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {activities.map((item) => {
        if (item.type === "project") {
          const project = item.data;
          return (
            <button
              key={`p-${project.id}`}
              onClick={() => onProjectClick(project)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors text-left group"
            >
              <FolderOpen className="w-4 h-4 text-primary/70 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                  {getProjectName(project.path)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {project.session_count} sessions
                </p>
              </div>
              <span className="text-xs text-muted-foreground/70 shrink-0">
                {formatTime(project.last_active)}
              </span>
            </button>
          );
        } else {
          const session = item.data;
          return (
            <button
              key={`s-${session.id}`}
              onClick={() => onSessionClick(session)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors text-left group"
            >
              <MessageSquare className="w-4 h-4 text-muted-foreground/70 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors">
                  {toReadable(session.summary) || "Untitled session"}
                </p>
                <p className="text-xs text-muted-foreground" title={`${session.message_count} messages total`}>
                  {session.rounds} rounds
                </p>
              </div>
              <span className="text-xs text-muted-foreground/70 shrink-0">
                {formatTime(session.last_modified)}
              </span>
            </button>
          );
        }
      })}
    </div>
  );
}
