import { atomWithStorage } from "jotai/utils";

// MessageView
export const originalChatAtom = atomWithStorage("lovcode:originalChat", true);
export const markdownPreviewAtom = atomWithStorage("lovcode:markdownPreview", false);
export const expandMessagesAtom = atomWithStorage("lovcode:expandMessages", true);

// SessionList
export const sessionContextTabAtom = atomWithStorage<"global" | "project">("lovcode:sessions:contextTab", "project");
export const sessionSelectModeAtom = atomWithStorage("lovcode:sessionSelectMode", false);
export const hideEmptySessionsAtom = atomWithStorage("lovcode-hide-empty-sessions", false);
export const userPromptsOnlyAtom = atomWithStorage("lovcode:userPromptsOnly", false);

// Sidebar session sort & view
export type SessionSortBy = "modified" | "created" | "path";
export const sidebarSessionSortByAtom = atomWithStorage<SessionSortBy>("lovcode:sidebar:sessionSortBy", "modified");
export type SidebarViewMode = "grouped" | "flat";
export const sidebarViewModeAtom = atomWithStorage<SidebarViewMode>("lovcode:sidebar:viewMode", "grouped");

// Archived sessions (hidden from sidebar by default, managed like a todo list)
export const archivedSessionIdsAtom = atomWithStorage<string[]>("lovcode:sidebar:archivedSessionIds", []);
export const showArchivedSessionsAtom = atomWithStorage("lovcode:sidebar:showArchived", false);

// Pinned sessions (sticky to top in lists). Compatible with Claude app's pin concept
// but stored locally — Claude app does not expose pin state in claude-code-sessions JSON.
export const pinnedSessionIdsAtom = atomWithStorage<string[]>("lovcode:sidebar:pinnedSessionIds", []);

// Local override: ids that were starred upstream by Claude app/web but the user
// unpinned in lovcode. Subtracted from the effective pinned set so toggling a
// Claude-starred session here actually un-pins it locally (without writing back
// to claude.ai). Cleared automatically if upstream un-stars the same id.
export const unpinnedAppIdsAtom = atomWithStorage<string[]>("lovcode:sidebar:unpinnedAppIds", []);

// Whether the Pinned section in the sidebar is collapsed
export const pinnedCollapsedAtom = atomWithStorage("lovcode:sidebar:pinnedCollapsed", false);
export const recentCollapsedAtom = atomWithStorage("lovcode:sidebar:recentCollapsed", false);
export const importCollapsedAtom = atomWithStorage("lovcode:sidebar:importCollapsed", false);

// ProjectList
export const chatViewModeAtom = atomWithStorage<"projects" | "sessions" | "chats">("lovcode:chatViewMode", "projects");
export const allProjectsSortByAtom = atomWithStorage<"name" | "recent" | "sessions">("lovcode:allProjects:sortBy", "recent");
export const hideEmptySessionsAllAtom = atomWithStorage("lovcode-hide-empty-sessions-all", false);
