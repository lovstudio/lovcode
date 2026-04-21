import { atomWithStorage } from "jotai/utils";

// MessageView
export const originalChatAtom = atomWithStorage("lovcode:originalChat", true);
export const markdownPreviewAtom = atomWithStorage("lovcode:markdownPreview", false);

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

// ProjectList
export const chatViewModeAtom = atomWithStorage<"projects" | "sessions" | "chats">("lovcode:chatViewMode", "projects");
export const allProjectsSortByAtom = atomWithStorage<"name" | "recent" | "sessions">("lovcode:allProjects:sortBy", "recent");
export const hideEmptySessionsAllAtom = atomWithStorage("lovcode-hide-empty-sessions-all", false);
