// App atoms
export { sidebarCollapsedAtom, marketplaceCategoryAtom, shortenPathsAtom, profileAtom, featureTabsLayoutAtom, verticalTabsSidebarWidthAtom, type FeatureTabsLayout } from "./atoms/app";

// UI atoms
export { selectedFileAtom, fileViewModeAtom, activePanelIdAtom, navigationStateAtom, viewAtom, viewHistoryAtom, historyIndexAtom } from "./atoms/ui";

// FileTree atoms
export { expandedPathsAtom } from "./atoms/fileTree";

// Chat atoms
export {
  originalChatAtom, markdownPreviewAtom,
  sessionContextTabAtom, sessionSelectModeAtom, hideEmptySessionsAtom, userPromptsOnlyAtom,
  chatViewModeAtom, allProjectsSortByAtom, hideEmptySessionsAllAtom,
  sidebarSessionSortByAtom, type SessionSortBy,
  sidebarViewModeAtom, type SidebarViewMode,
  archivedSessionIdsAtom, showArchivedSessionsAtom,
  pinnedSessionIdsAtom,
} from "./atoms/chat";

// Settings atoms
export { routerTestStatusAtom, routerTestMessageAtom } from "./atoms/settings";

// Commands atoms
export {
  commandsSortKeyAtom, commandsSortDirAtom, commandsShowDeprecatedAtom,
  commandsViewModeAtom, commandsExpandedFoldersAtom,
} from "./atoms/commands";

// Knowledge atoms
export {
  referenceCollapsedGroupsAtom, referenceExpandedSourceAtom, referenceScrollPositionAtom,
} from "./atoms/knowledge";

// Workspace atoms
export {
  primaryFeatureAtom,
  workspaceDataAtom, workspaceLoadingAtom, collapsedProjectGroupsAtom,
  featureSidebarExpandedPanelsAtom, featureSidebarPinnedExpandedAtom, featureSidebarFilesExpandedAtom,
  sidebarModeAtom, dashboardSessionsVisibleAtom,
  type SidebarMode,
} from "./atoms/workspace";

// Component atoms
export { collapsibleStatesAtom, docReaderCollapsedGroupsAtom } from "./atoms/components";

// Home atoms
export { activityViewModeAtom, commandRangeAtom, commandModeAtom } from "./atoms/home";
