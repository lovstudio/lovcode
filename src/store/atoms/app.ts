import { atomWithStorage } from "jotai/utils";
import type { TemplateCategory, UserProfile } from "@/types";

// 侧边栏折叠状态 (always true - expanded sidebar removed from App.tsx)
export const sidebarCollapsedAtom = atomWithStorage("lovcode:sidebarCollapsed", true);

// Marketplace 分类
export const marketplaceCategoryAtom = atomWithStorage<TemplateCategory>("lovcode:marketplaceCategory", "commands");

// 路径缩短显示
export const shortenPathsAtom = atomWithStorage("lovcode:shortenPaths", true);

// 用户档案
export const profileAtom = atomWithStorage<UserProfile>("lovcode:profile", { nickname: "", avatarUrl: "" });

