import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "@support-agent/shared/api/updates";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema";
import { resetConfigForTests } from "../config";
import { createUser, request, resetDatabase } from "../test/helpers";

// Sign-in is the OIDC provider's job; these tests act as a person from the database.
vi.mock("../auth/resolve", async () => {
  const { eq: equals } = await import("drizzle-orm");
  const { users } = await import("../db/schema");
  return {
    resolvePrincipal: async (db: ReturnType<typeof getDb>, headers: Headers) => {
      const id = headers.get("x-test-user");
      if (!id) return null;
      const [user] = await db.select().from(users).where(equals(users.id, id));
      return user?.isActive
        ? { kind: "user", id: user.id, email: user.email, name: user.name, role: user.role, image: null }
        : null;
    },
  };
});

const STATUS: UpdaterStatus = {
  updater: "0.2.0",
  mode: "host",
  channel: "stable",
  channelLocked: null,
  installed: "0.2.0",
  available: {
    version: "0.2.1",
    preview: false,
    publishedAt: "2026-11-18T08:00:00.000Z",
    url: "https://github.com/meldgrove/support-agent/releases/tag/v0.2.1",
    notes: ["Fix the sign-in loop"],
    changes: 1,
    installsAt: "2026-11-21T08:00:00.000Z",
    failed: null,
  },
  attention: null,
  installing: null,
  last: null,
  checking: false,
  checkedAt: "2026-11-19T08:00:00.000Z",
  error: null,
  automatic: true,
  cooldown: "3d",
  window: "02:00-05:00",
  timezone: "UTC",
};
const INSTALLING: UpdaterStatus = {
  ...STATUS,
  installing: { version: "0.2.1", startedAt: "2026-11-19T08:01:00.000Z", manual: true, stage: "requested" },
};

type Reply = { status: number; body: unknown } | Error;
const calls: { url: string; method: string; body: unknown }[] = [];
let replies: Reply[] = [];

beforeEach(async () => {
  await resetDatabase();
  process.env.UPDATER_URL = "http://updater.test:8080";
  resetConfigForTests();
  calls.length = 0;
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const reply = replies.shift() ?? new TypeError("fetch failed");
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPDATER_URL;
  resetConfigForTests();
});

const ROUTES = [
  ["GET", "/api/v1/updates", undefined],
  ["POST", "/api/v1/updates/check", {}],
  ["POST", "/api/v1/updates/install", { version: "0.2.1" }],
  ["POST", "/api/v1/updates/channel", { channel: "preview" }],
] as const;

describe("access", () => {
  it("lets only admins near the updater", async () => {
    const editor = await createUser("editor");
    for (const [method, path, body] of ROUTES) {
      expect((await request(method, path, { body })).status).toBe(401);
      expect((await request(method, path, { userId: editor.id, body })).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("rejects cross-site changes before calling the updater", async () => {
    const admin = await createUser("admin");
    const { createApp } = await import("../http/app");
    const response = await createApp().request("/api/v1/updates/install", {
      method: "POST",
      headers: {
        origin: "https://evil.example.org",
        "x-test-user": admin.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: "0.2.1" }),
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("updates", () => {
  it("answers with the updater's status and the app's version", async () => {
    const admin = await createUser("admin");
    replies = [{ status: 200, body: STATUS }];
    const response = await request("GET", "/api/v1/updates", { userId: admin.id });
    expect(response).toEqual({
      status: 200,
      body: { app: { version: null }, reachable: true, updater: STATUS, error: null },
    });
    expect(calls).toEqual([{ url: "http://updater.test:8080/v1/status", method: "GET", body: null }]);
  });

  it("says when no updater answers", async () => {
    const admin = await createUser("admin");
    replies = [new TypeError("fetch failed")];
    const response = await request("GET", "/api/v1/updates", { userId: admin.id });
    expect(response).toEqual({
      status: 200,
      body: {
        app: { version: null },
        reachable: false,
        updater: null,
        error: "No update service answers at http://updater.test:8080.",
      },
    });

    process.env.UPDATER_URL = "";
    resetConfigForTests();
    calls.length = 0;
    const off = await request("POST", "/api/v1/updates/check", { userId: admin.id, body: {} });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ reachable: false, updater: null });
    expect(calls).toEqual([]);
  });

  it("checks on request", async () => {
    const admin = await createUser("admin");
    replies = [{ status: 200, body: STATUS }];
    const response = await request("POST", "/api/v1/updates/check", { userId: admin.id, body: {} });
    expect(response.status).toBe(200);
    expect(response.body.updater).toEqual(STATUS);
    expect(calls).toEqual([{ url: "http://updater.test:8080/v1/check", method: "POST", body: null }]);
  });

  it("starts an installation and records it", async () => {
    const admin = await createUser("admin");
    replies = [{ status: 202, body: INSTALLING }];
    const response = await request("POST", "/api/v1/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1", extra: "dropped" },
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ reachable: true, updater: INSTALLING, error: null });
    expect(calls).toEqual([
      { url: "http://updater.test:8080/v1/install", method: "POST", body: { version: "0.2.1" } },
    ]);
    const [entry] = await getDb().select().from(auditLog);
    expect(entry).toMatchObject({ action: "updates.install", summary: "Started the installation of 0.2.1" });
  });

  it("validates the version and the channel before calling the updater", async () => {
    const admin = await createUser("admin");
    for (const version of [
      "latest",
      "0.2",
      "0.2.1-rc.1",
      "0.2.1\nversion=9.9.9",
      "sha256:ABCDEF012345",
      "",
    ]) {
      const response = await request("POST", "/api/v1/updates/install", {
        userId: admin.id,
        body: { version },
      });
      expect(response.status, version).toBe(422);
      expect(response.body.error.fields).toHaveProperty("version");
    }
    const channel = await request("POST", "/api/v1/updates/channel", {
      userId: admin.id,
      body: { channel: "nightly" },
    });
    expect(channel.status).toBe(422);
    expect(calls).toEqual([]);

    replies = [
      { status: 202, body: INSTALLING },
      { status: 202, body: INSTALLING },
    ];
    for (const version of ["0.2.1-preview.3", "sha256:0123456789ab"]) {
      expect(
        (await request("POST", "/api/v1/updates/install", { userId: admin.id, body: { version } })).status,
      ).toBe(202);
    }
  });

  it("turns a refusal into 409 with the reason and the latest status", async () => {
    const admin = await createUser("admin");
    replies = [
      { status: 409, body: { error: "0.2.1 is being installed." } },
      { status: 200, body: INSTALLING },
    ];
    const response = await request("POST", "/api/v1/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
    });
    expect(response).toEqual({
      status: 409,
      body: {
        app: { version: null },
        reachable: true,
        updater: INSTALLING,
        error: "0.2.1 is being installed.",
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://updater.test:8080/v1/install",
      "http://updater.test:8080/v1/status",
    ]);
    expect(await getDb().select().from(auditLog)).toEqual([]);
  });

  it("switches the channel, unless it is locked", async () => {
    const admin = await createUser("admin");
    const locked = "The platform's image tag latest decides which updates install. Change it there.";
    replies = [
      { status: 200, body: { ...STATUS, channel: "preview" } },
      { status: 409, body: { error: locked } },
      { status: 200, body: { ...STATUS, channelLocked: locked } },
    ];
    const switched = await request("POST", "/api/v1/updates/channel", {
      userId: admin.id,
      body: { channel: "preview" },
    });
    expect(switched.status).toBe(200);
    expect(switched.body.updater.channel).toBe("preview");
    expect(calls[0]).toEqual({
      url: "http://updater.test:8080/v1/channel",
      method: "POST",
      body: { channel: "preview" },
    });
    const [entry] = await getDb().select().from(auditLog);
    expect(entry?.summary).toBe("Switched updates to the Preview channel");

    const refused = await request("POST", "/api/v1/updates/channel", {
      userId: admin.id,
      body: { channel: "stable" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: locked, updater: { channelLocked: locked } });
  });
});
