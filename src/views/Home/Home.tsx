import { useMemo } from "react";
import type { FeatureType, Project, Session, LocalCommand } from "../../types";
import { FEATURES } from "../../constants";
import { ActivityHeatmap, RecentActivity, QuickActions, FeaturedCarousel } from "../../components/home";
import { useInvokeQuery } from "../../hooks";

interface HomeProps {
  onFeatureClick: (feature: FeatureType) => void;
  onProjectClick: (project: Project) => void;
  onSessionClick: (session: Session) => void;
  onSearch: () => void;
  onOpenAnnualReport: () => void;
}

interface ActivityStats {
  daily: Record<string, number>;
  hourly: Record<string, number>;
  detailed: Record<string, number>;
}

export function Home({ onFeatureClick, onProjectClick, onSessionClick, onSearch, onOpenAnnualReport }: HomeProps) {
  const { data: projects } = useInvokeQuery<Project[]>(["projects"], "list_projects");
  const { data: sessions } = useInvokeQuery<Session[]>(["sessions"], "list_all_sessions");
  const { data: commands } = useInvokeQuery<LocalCommand[]>(["commands"], "list_local_commands");
  const { data: activityStats } = useInvokeQuery<ActivityStats>(["activityStats"], "get_activity_stats");

  const data = projects && sessions && commands ? { projects, sessions, commands } : null;


  // Get last active project
  const lastProject = useMemo(() => {
    if (!data || data.projects.length === 0) return null;
    return data.projects.reduce((latest, p) =>
      p.last_active > latest.last_active ? p : latest
    );
  }, [data]);

  // Stats
  const stats = useMemo(() => {
    if (!data) return null;
    const totalMessages = data.sessions.reduce((sum, s) => sum + s.message_count, 0);
    return {
      projects: data.projects.length,
      sessions: data.sessions.length,
      commands: data.commands.length,
      messages: totalMessages,
    };
  }, [data]);

  return (
    <div className="flex flex-col min-h-full px-6 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="font-serif text-4xl font-bold text-primary mb-2 tracking-tight flex items-center justify-center gap-3">
          <img src="/logo.png" alt="Lovcode" className="w-10 h-10" />
          Lovcode
        </h1>
        <p className="text-muted-foreground">The Super Creatorpreneur OS</p>
      </div>

      {/* Featured Carousel */}
      <div className="max-w-xl mx-auto w-full mb-6">
        <FeaturedCarousel onOpenAnnualReport={onOpenAnnualReport} />
      </div>

      {/* Quick Actions */}
      <div className="flex justify-center mb-8">
        <QuickActions
          lastProject={lastProject}
          onContinue={onProjectClick}
          onSearch={onSearch}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 max-w-4xl mx-auto w-full space-y-6">
        {/* Activity Heatmap + Stats */}
        {data && (
          <div className="bg-card/50 rounded-2xl p-5 border border-border/40">
            {activityStats && (
              <ActivityHeatmap
                daily={activityStats.daily}
                detailed={activityStats.detailed}
              />
            )}
            {/* Inline Stats */}
            {stats && (
              <div className="flex items-center gap-6 mt-4 pt-4 border-t border-border/40 text-sm text-muted-foreground">
                <span>
                  <strong className="text-foreground font-serif">{stats.projects}</strong> workspaces
                </span>
                <span>
                  <strong className="text-foreground font-serif">{stats.sessions}</strong> sessions
                </span>
                <span>
                  <strong className="text-foreground font-serif">{stats.commands}</strong> commands
                </span>
              </div>
            )}
          </div>
        )}

        {/* Two Column: Recent Activity + Features */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Recent Activity */}
          <div className="bg-card/50 rounded-2xl p-5 border border-border/40">
            <h2 className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
              Recent Activity
            </h2>
            {data && (
              <RecentActivity
                projects={data.projects}
                sessions={data.sessions}
                onProjectClick={onProjectClick}
                onSessionClick={onSessionClick}
              />
            )}
          </div>

          {/* Feature Grid */}
          <div className="bg-card/50 rounded-2xl p-5 border border-border/40">
            <h2 className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
              Features
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {FEATURES.map((feature) => (
                <button
                  key={feature.type}
                  onClick={() => onFeatureClick(feature.type)}
                  className={`p-3 rounded-xl border transition-all duration-200 text-left ${
                    feature.available
                      ? "bg-background border-border/60 hover:border-primary hover:shadow-sm cursor-pointer"
                      : "bg-muted/30 border-transparent cursor-default"
                  }`}
                  disabled={!feature.available}
                >
                  <span
                    className={`text-sm ${
                      feature.available ? "text-foreground" : "text-muted-foreground/60"
                    }`}
                  >
                    {feature.label}
                  </span>
                  {!feature.available && (
                    <span className="text-[10px] text-muted-foreground/50 italic ml-2">
                      Soon
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
