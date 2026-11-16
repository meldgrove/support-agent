import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  BookOpen,
  Bot,
  Hash,
  Home,
  MessagesSquare,
  ScrollText,
  Settings,
  UsersRound,
} from "lucide-react";
import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    workspace: "Support",
    admin: "Administration",
    overview: "Overview",
    agents: "Agents",
    conversations: "Conversations",
    knowledge: "Knowledge sources",
    providers: "Providers",
    slack: "Slack",
    users: "Users",
    settings: "Settings",
    audit: "Audit log",
  },
  de: {
    workspace: "Support",
    admin: "Verwaltung",
    overview: "Übersicht",
    agents: "Agenten",
    conversations: "Unterhaltungen",
    knowledge: "Wissensquellen",
    providers: "Anbieter",
    slack: "Slack",
    users: "Benutzer",
    settings: "Einstellungen",
    audit: "Protokoll",
  },
});

export type NavKey = keyof typeof navMessages.en;
export type NavItem = { key: NavKey; to: string; icon: LucideIcon };
export type NavGroup = { key: NavKey; items: NavItem[]; adminOnly?: boolean };

/** The sidebar. Each module's main page lives at the `to` path. */
export const NAVIGATION: NavGroup[] = [
  {
    key: "workspace",
    items: [
      { key: "overview", to: "/", icon: Home },
      { key: "agents", to: "/agents", icon: Bot },
      { key: "conversations", to: "/conversations", icon: MessagesSquare },
    ],
  },
  {
    key: "admin",
    adminOnly: true,
    items: [
      { key: "knowledge", to: "/knowledge", icon: BookOpen },
      { key: "providers", to: "/providers", icon: Blocks },
      { key: "slack", to: "/slack", icon: Hash },
      { key: "users", to: "/users", icon: UsersRound },
      { key: "settings", to: "/settings", icon: Settings },
      { key: "audit", to: "/audit", icon: ScrollText },
    ],
  },
];
