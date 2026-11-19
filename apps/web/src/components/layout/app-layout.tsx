import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Bot, ChevronsUpDown, Languages, LogOut, SunMoon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@meldgrove/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@meldgrove/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@meldgrove/ui/avatar";
import { Separator } from "@meldgrove/ui/separator";
import { TooltipProvider } from "@meldgrove/ui/tooltip";
import { useMe } from "@/hooks/use-me";
import { THEMES, useTheme, type Theme } from "@/lib/theme";
import { authClient } from "@/lib/auth-client";
import { useAuthConfig } from "@/lib/auth-config";
import { queryClient } from "@/lib/query";
import { defineMessages, useT } from "@/i18n";
import { useLocaleChoice, type LocaleChoice } from "@/i18n/provider";
import { NAVIGATION, navMessages } from "@/app/navigation";
import { AdminUpdateButton, AdminUpdates } from "@/modules/updates/updates";

const messages = defineMessages({
  en: {
    signOut: "Sign out",
    skip: "Skip to content",
    language: "Language",
    browser: "Browser language",
    theme: "Appearance",
    system: "Device setting",
    light: "Light",
    dark: "Dark",
    admin: "Admin",
    editor: "Editor",
  },
  de: {
    signOut: "Abmelden",
    skip: "Zum Inhalt springen",
    language: "Sprache",
    browser: "Sprache des Browsers",
    theme: "Darstellung",
    system: "Wie das Gerät",
    light: "Hell",
    dark: "Dunkel",
    admin: "Admin",
    editor: "Bearbeitung",
  },
});

const DEFAULT_APP_NAME = "Support Agent";

export function initials(name: string) {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function UserMenu() {
  const me = useMe();
  const m = useT(messages);
  const { theme, setTheme } = useTheme();
  const { choice, setChoice } = useLocaleChoice();
  const label = me.name || me.email;

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/sign-in");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Avatar className="size-8 rounded-lg">
            {me.image ? <AvatarImage src={me.image} alt="" /> : null}
            <AvatarFallback className="rounded-lg">{initials(label)}</AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{label}</span>
            <span className="text-muted-foreground truncate text-xs">{me.email}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{label}</div>
          <div className="text-muted-foreground truncate text-xs">
            {me.email} · {m(me.role)}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Languages />
            {m("language")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={choice}
              onValueChange={(value) => setChoice(value as LocaleChoice)}
            >
              <DropdownMenuRadioItem value="browser">{m("browser")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="de">Deutsch</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon />
            {m("theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              {THEMES.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {m(option)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut />
          {m("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppSidebar({ appName }: { appName: string }) {
  const me = useMe();
  const t = useT(navMessages);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isActive = (to: string) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Bot className="size-4" />
                </div>
                <span className="truncate font-semibold">{appName}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAVIGATION.filter((group) => !group.adminOnly || me.role === "admin").map((group) => (
          <SidebarGroup key={group.key}>
            <SidebarGroupLabel>{t(group.key)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={t(item.key)}>
                      <Link to={item.to}>
                        <item.icon />
                        <span>{t(item.key)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The signed-in application frame: sidebar, header and the page. */
export function AppLayout() {
  const m = useT(messages);
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  return (
    <AdminUpdates appName={appName}>
      <TooltipProvider delayDuration={300}>
        <SidebarProvider>
          <a
            href="#main"
            className="bg-background sr-only z-50 rounded-md px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
          >
            {m("skip")}
          </a>
          <AppSidebar appName={appName} />
          <SidebarInset className="min-w-0">
            <header className="bg-background/95 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <span className="min-w-0 truncate text-sm font-medium">{appName}</span>
              <div className="ml-auto flex items-center">
                <AdminUpdateButton />
              </div>
            </header>
            <main id="main" className="flex-1">
              <Outlet />
            </main>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </AdminUpdates>
  );
}
