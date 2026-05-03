import { type ReactNode } from "react";
import { useAtom } from "jotai";
import { motion, AnimatePresence } from "framer-motion";
import {
  PersonIcon, ChevronLeftIcon, ChevronRightIcon,
  CounterClockwiseClockIcon, BookmarkIcon, LayersIcon, CalendarIcon,
} from "@radix-ui/react-icons";
import { Avatar, AvatarImage, AvatarFallback } from "../ui/avatar";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { profileAtom } from "@/store";
import type { FeatureType } from "@/types";

interface GlobalHeaderProps {
  currentFeature: FeatureType | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onFeatureClick: (feature: FeatureType) => void;
  onShowProfileDialog: () => void;
  onShowSettings: () => void;
}

// Top-nav features. Active state is derived from currentFeature so the
// highlight syncs with the URL (back/forward, sidebar links, deep links).
const MAIN_NAV: { feature: FeatureType; label: string; icon: ReactNode; matches: (f: FeatureType | null) => boolean }[] = [
  {
    feature: "chat",
    label: "History",
    icon: <CounterClockwiseClockIcon className="w-4 h-4" />,
    matches: (f) => f === "chat",
  },
  {
    feature: "features",
    label: "Configuration",
    icon: <LayersIcon className="w-4 h-4" />,
    matches: (f) => f === "features",
  },
  {
    feature: "kb-distill",
    label: "Knowledge",
    icon: <BookmarkIcon className="w-4 h-4" />,
    matches: (f) => !!f && f.startsWith("kb-"),
  },
  {
    feature: "events",
    label: "Events",
    icon: <CalendarIcon className="w-4 h-4" />,
    matches: (f) => f === "events",
  },
];

export function GlobalHeader({
  currentFeature,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onFeatureClick,
  onShowProfileDialog,
  onShowSettings,
}: GlobalHeaderProps) {
  const [profile] = useAtom(profileAtom);

  return (
    <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center border-b border-border bg-card">
      {/* Left: back/forward (offset for traffic-light buttons on macOS) */}
      <div className="flex items-center gap-0.5 pl-[80px]">
        <button
          onClick={onGoBack}
          disabled={!canGoBack}
          className="p-1.5 rounded-md text-muted-foreground hover:text-ink hover:bg-card-alt disabled:opacity-30 disabled:pointer-events-none"
          title="Go back"
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </button>
        <button
          onClick={onGoForward}
          disabled={!canGoForward}
          className="p-1.5 rounded-md text-muted-foreground hover:text-ink hover:bg-card-alt disabled:opacity-30 disabled:pointer-events-none"
          title="Go forward"
        >
          <ChevronRightIcon className="w-5 h-5" />
        </button>
      </div>
      {/* Center: nav */}
      <div className="flex-1 flex items-center justify-center gap-0.5" data-tauri-drag-region>
        {MAIN_NAV.map((item) => (
          <NavButton
            key={item.feature}
            isActive={item.matches(currentFeature)}
            onClick={() => onFeatureClick(item.feature)}
            icon={item.icon}
            label={item.label}
          />
        ))}
      </div>
      {/* Right: profile */}
      <ProfileMenu
        profile={profile}
        onShowProfileDialog={onShowProfileDialog}
        onShowSettings={onShowSettings}
      />
    </div>
  );
}

function ProfileMenu({
  profile,
  onShowProfileDialog,
  onShowSettings,
}: {
  profile: { nickname: string; avatarUrl: string };
  onShowProfileDialog: () => void;
  onShowSettings: () => void;
}) {
  return (
    <div className="pr-4">
      <Popover>
        <PopoverTrigger className="rounded-full hover:ring-2 hover:ring-primary/50 transition-all">
          <Avatar className="h-6 w-6 cursor-pointer">
            {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt={profile.nickname || "User"} /> : null}
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {profile.nickname ? profile.nickname.charAt(0).toUpperCase() : <PersonIcon className="w-4 h-4" />}
            </AvatarFallback>
          </Avatar>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-2">
          <div className="space-y-1">
            {profile.nickname && (
              <p className="px-2 py-1.5 text-sm font-medium text-ink truncate">{profile.nickname}</p>
            )}
            <button
              onClick={onShowProfileDialog}
              className="w-full text-left px-2 py-1.5 text-sm text-muted-foreground hover:text-ink hover:bg-card-alt rounded-md transition-colors"
            >
              Edit Profile
            </button>
            <button
              onClick={onShowSettings}
              className="w-full text-left px-2 py-1.5 text-sm text-muted-foreground hover:text-ink hover:bg-card-alt rounded-md transition-colors"
            >
              Settings
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function NavButton({
  isActive,
  onClick,
  icon,
  label,
}: {
  isActive: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <motion.button
      onClick={onClick}
      className={`px-2 py-1.5 rounded flex items-center gap-1.5 overflow-hidden ${
        isActive
          ? "bg-primary/10 text-primary [&_img]:opacity-100"
          : "text-primary/50 hover:text-primary/70 hover:bg-card-alt [&_img]:opacity-50 hover:[&_img]:opacity-70"
      }`}
      title={label}
      layout
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {icon}
      <AnimatePresence mode="wait">
        {isActive && (
          <motion.span
            key={label}
            className="text-sm whitespace-nowrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}
