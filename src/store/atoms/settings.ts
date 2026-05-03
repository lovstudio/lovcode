import { atomWithStorage } from "jotai/utils";

// Router test status
export const routerTestStatusAtom = atomWithStorage<Record<string, "idle" | "loading" | "success" | "error">>(
  "lovcode:settings:routerTestStatus",
  {}
);

export const routerTestMessageAtom = atomWithStorage<Record<string, string>>(
  "lovcode:settings:routerTestMessage",
  {}
);

// When true, register CmdOrCtrl+K as a system-level shortcut so the chat
// search modal can be opened even while the app is in the background.
export const globalChatSearchHotkeyAtom = atomWithStorage<boolean>(
  "lovcode:settings:globalChatSearchHotkey",
  false,
);
