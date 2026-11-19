import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders, stubFetch } from "@/test-utils";
import { UpdateButton } from "./update-button";

vi.mock("@/hooks/use-me", () => ({ useIsAdmin: () => true }));
vi.mock("@/lib/auth-config", () => ({ useAuthConfig: () => ({ appName: "Support Agent" }) }));

/** Mode off: Updater 0.2 refuses every install. */
function off(overrides: Partial<UpdaterStatus> = {}): UpdatesResponse {
  return {
    app: { version: "0.2.0" },
    reachable: true,
    updater: {
      updater: "0.2.0",
      mode: "off",
      channel: "stable",
      channelLocked: null,
      installed: "0.2.0",
      available: {
        version: "0.2.1",
        preview: false,
        publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        url: "https://github.com/meldgrove/support-agent/releases/tag/v0.2.1",
        notes: ["Answer in threads"],
        changes: 1,
        installsAt: null,
        failed: null,
      },
      attention: null,
      installing: null,
      last: null,
      checking: false,
      checkedAt: new Date().toISOString(),
      error: null,
      automatic: false,
      cooldown: "3d",
      window: null,
      timezone: "UTC",
      ...overrides,
    },
    error: null,
  };
}

function renderButton(locale: "en" | "de" = "en") {
  return renderWithProviders(
    <TooltipProvider>
      <UpdateButton />
    </TooltipProvider>,
    { locale },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("UpdateButton while automatic updates are off", () => {
  it("shows a new release without installing it", async () => {
    stubFetch({ body: off() });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("Answer in threads");
    expect(within(popover).getByRole("link", { name: /Release notes/ })).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /Install now/ })).not.toBeInTheDocument();
    expect(popover).toHaveTextContent(
      "Automatic updates are off on this server, so it cannot install from here. See the deployment guide.",
    );
    expect(within(popover).getByRole("link", { name: "deployment guide" })).toHaveAttribute(
      "href",
      expect.stringContaining("docs/deployment.md"),
    );
  });

  it("says so in German", async () => {
    stubFetch({ body: off() });
    renderButton("de");

    await userEvent.click(await screen.findByRole("button", { name: "Update verfügbar · 0.2.1" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Automatische Updates sind auf diesem Server aus, daher kann es hier nicht installiert werden. Siehe Anleitung zum Deployment.",
    );
  });

  it("is off when nothing is new", async () => {
    stubFetch({ body: off({ available: null }) });
    renderButton();

    expect(
      await screen.findByRole("button", { name: "Automatic updates are off on this server" }),
    ).toBeInTheDocument();
  });
});
