import { describe, expect, it } from "vitest";
import { updaterStatusSchema, type UpdatesResponse } from "@support-agent/shared/api/updates";
import { buttonState } from "./state";

/** Answers captured from Updater 0.2 (against GHCR and GitHub), shared with the server's tests. */
const samples = import.meta.glob<unknown>("../../../../server/src/test/fixtures/updater-0.2/*.json", {
  eager: true,
  import: "default",
});

function sample(name: string): UpdatesResponse {
  const raw = samples[`../../../../server/src/test/fixtures/updater-0.2/${name}.json`];
  if (raw === undefined) throw new Error(`No sample ${name}`);
  const updater = updaterStatusSchema.parse(raw);
  return { app: { version: updater.installed }, reachable: true, updater, error: null };
}

function stateOf(name: string) {
  return buttonState({
    response: sample(name),
    waiting: null,
    checking: false,
    failing: false,
    now: Date.parse("2026-11-19T04:00:00Z"),
  });
}

describe("the button with the real answers of Updater 0.2", () => {
  it("parses every sample", () => {
    expect(Object.keys(samples).length).toBeGreaterThanOrEqual(7);
    for (const raw of Object.values(samples)) expect(updaterStatusSchema.safeParse(raw).success).toBe(true);
  });

  it("shows the update in mode off too (the popover installs nothing there)", () => {
    expect(stateOf("status-off-available-attention")).toMatchObject({
      kind: "available",
      update: { version: "0.2.1" },
      attention: { version: "0.3.1" },
    });
  });

  it("offers the update a server installs", () => {
    expect(stateOf("status-host-available")).toMatchObject({
      kind: "available",
      update: { version: "0.1.3", installsAt: "2026-11-21T18:21:25Z" },
      attention: null,
    });
  });

  it("is current when the platform decides and offers nothing", () => {
    expect(stateOf("status-platform-locked")).toEqual({ kind: "current" });
  });

  it("shows a running installation and its stage", () => {
    expect(stateOf("status-installing")).toEqual({
      kind: "installing",
      version: "0.1.3",
      stage: "pulling",
      slow: false,
    });
    expect(stateOf("install-202")).toMatchObject({
      kind: "installing",
      version: "0.1.3",
      stage: "requested",
    });
  });

  it("shows a rolled-back installation as failed, also after switching to Preview", () => {
    for (const name of ["status-failed", "status-preview"]) {
      expect(stateOf(name)).toMatchObject({
        kind: "failed",
        version: "0.1.3",
        message: "container library-web-1 is unhealthy",
        update: { version: "0.1.3" },
      });
    }
  });
});
