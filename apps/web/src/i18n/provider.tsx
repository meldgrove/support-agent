import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LocaleContext } from "./index";
import { isLocale, pickLocale, type Locale } from "./locales";

/** "browser" follows the browser's languages; a locale overrides them in this browser. */
export type LocaleChoice = Locale | "browser";

const STORAGE_KEY = "support-agent.locale";

const LocaleChoiceContext = createContext<{
  choice: LocaleChoice;
  setChoice: (choice: LocaleChoice) => void;
}>({
  choice: "browser",
  setChoice: () => undefined,
});

function storedChoice(): LocaleChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : "browser";
  } catch {
    return "browser";
  }
}

function browserLocale(): Locale {
  return pickLocale(navigator.languages?.join(",") || navigator.language);
}

/** Provides the interface language to `useT` and sets `<html lang>`. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<LocaleChoice>(storedChoice);
  const locale = choice === "browser" ? browserLocale() : choice;

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      if (choice === "browser") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Private mode: the choice still applies for this page.
    }
  }, [choice, locale]);

  return (
    <LocaleChoiceContext.Provider value={{ choice, setChoice }}>
      <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
    </LocaleChoiceContext.Provider>
  );
}

export function useLocaleChoice() {
  return useContext(LocaleChoiceContext);
}
