import { Page, PageHeader } from "@meldgrove/ui/page";
import { AboutCard, AppearanceCard, KeyboardShortcutsCard } from "@meldgrove/ui/settings-cards";
import { useT } from "@/i18n";
import { REPOSITORY_URL } from "@/lib/repository";
import { useTheme } from "@/lib/theme";
import { messages } from "./messages";

/** The person's own settings, for every role: appearance, single-letter shortcuts (WCAG 2.1.4), about. */
export function PreferencesPage() {
  const t = useT(messages);
  const { theme, setTheme } = useTheme();
  return (
    <Page className="max-w-3xl">
      <PageHeader title={t("title")} description={t("description")} />
      <AppearanceCard value={theme} onChange={setTheme} />
      <KeyboardShortcutsCard />
      {/* The software's name, also when an installation renames the app. */}
      <AboutCard appName="Support Agent" repositoryUrl={REPOSITORY_URL} />
    </Page>
  );
}
