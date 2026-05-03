/**
 * URL Detail Fetcher Hook
 *
 * Initial view is already set by the atom (at module load time from URL).
 * This hook only handles async fetching for detail routes that need data.
 *
 * Flow:
 * 1. Module loads → atom parses URL → initial state set (e.g., skills list)
 * 2. React renders immediately with correct list view
 * 3. This hook checks if URL has detail segment → async fetches → navigates to detail
 */
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { navigationStateAtom } from "../store";
import type { LocalSkill, LocalCommand } from "../types";
import { skillToTemplate } from "../views/Skills/skillTemplates";

/**
 * Hook to fetch detail data for detail routes.
 * Initial list view is already rendered; this handles the async detail navigation.
 */
export function useUrlInit() {
  const setNavState = useSetAtom(navigationStateAtom);
  const initRef = useRef(false);

  useEffect(() => {
    // Only run once
    if (initRef.current) return;
    initRef.current = true;

    const hash = window.location.hash.slice(1) || "/";
    const path = hash.startsWith("/") ? hash.slice(1) : hash;
    const segments = path.split("/").filter(Boolean);

    if (segments.length < 2) return; // No detail to fetch

    const [first, second] = segments;

    // Handle detail routes that need async data fetching
    if (first === "skills" && second) {
      const skillName = decodeURIComponent(second);
      invoke<LocalSkill[]>("list_local_skills").then(skills => {
        const skill = skills.find(s => s.name === skillName);
        if (skill) {
          setNavState(prev => ({
            history: [...prev.history, {
              type: "feature-template-detail" as const,
              template: skillToTemplate(skill),
              category: "skills" as const,
              fromFeature: "skills" as const,
              localPath: skill.path,
              isInstalled: true,
            }],
            index: prev.index + 1,
          }));
        }
      }).catch(e => console.error("Failed to fetch skill:", e));
    }

    if (first === "commands" && second) {
      const cmdName = decodeURIComponent(second);
      invoke<LocalCommand[]>("list_local_commands").then(commands => {
        const cmd = commands.find(c => c.name === cmdName);
        if (cmd) {
          setNavState(prev => ({
            history: [...prev.history, { type: "command-detail", command: cmd }],
            index: prev.index + 1,
          }));
        }
      }).catch(e => console.error("Failed to fetch command:", e));
    }
  }, [setNavState]);
}
