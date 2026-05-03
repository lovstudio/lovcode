import { atomWithStorage } from "jotai/utils";

// When true, register CmdOrCtrl+K as a system-level shortcut so the chat
// search modal can be opened even while the app is in the background.
export const globalChatSearchHotkeyAtom = atomWithStorage<boolean>(
  "lovcode:settings:globalChatSearchHotkey",
  false,
);
