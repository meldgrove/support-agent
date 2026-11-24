import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
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

// The updater of these tests refuses requests without this token, as with API_TOKEN set.
const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
let updater: FakeUpdater;

beforeAll(async () => {
  updater = await startFakeUpdater({ token: TOKEN });
});
afterAll(() => updater.close());

beforeEach(async () => {
  await resetDatabase();
  process.env.UPDATER_URL = updater.url;
  process.env.UPDATER_TOKEN = TOKEN;
  process.env.APP_VERSION = "0.2.0";
  resetConfigForTests();
  updater.calls.length = 0;
  updater.respond(() => ({ body: updaterStatus() }));
});
afterEach(() => {
  delete process.env.UPDATER_URL;
  delete process.env.UPDATER_TOKEN;
  delete process.env.APP_VERSION;
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
    expect(updater.calls).toEqual([]);
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
    expect(updater.calls).toEqual([]);
  });
});

describe("updates", () => {
  it("gives admins the updater's status, asked with UPDATER_TOKEN", async () => {
    const admin = await createUser("admin");
    const { createApp } = await import("../http/app");
    const response = await createApp().request("/api/v1/updates", {
      headers: { "x-test-user": admin.id, "x-request-id": "updates-status-0001" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The headers of the app's middleware stay on the handler's answer.
    expect(response.headers.get("x-request-id")).toBe("updates-status-0001");
    expect(await response.json()).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: updaterStatus(),
      error: null,
    });
    expect(updater.calls).toEqual([
      { method: "GET", path: "/v1/status", body: null, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("starts an installation and switches the channel, and records both", async () => {
    const admin = await createUser("admin");
    const installing = updaterStatus({
      installing: {
        version: "0.2.1",
        startedAt: "2026-11-19T08:01:00.000Z",
        manual: true,
        stage: "requested",
      },
    });
    updater.respond((call) => ({
      status: call.path === "/v1/install" ? 202 : 200,
      body: call.path === "/v1/install" ? installing : updaterStatus({ channel: "preview" }),
    }));

    const { createApp } = await import("../http/app");
    const install = await createApp().request("/api/v1/updates/install", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "x-test-user": admin.id,
        "x-request-id": "updates-install-0001",
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: "0.2.1" }),
    });
    expect(install.status).toBe(202);
    expect(install.headers.get("x-request-id")).toBe("updates-install-0001");
    expect(await install.json()).toMatchObject({ reachable: true, updater: installing, error: null });
    const channel = await request("POST", "/api/v1/updates/channel", {
      userId: admin.id,
      body: { channel: "preview" },
    });
    expect(channel.status).toBe(200);

    expect(updater.calls).toEqual([
      { method: "POST", path: "/v1/install", body: { version: "0.2.1" }, authorization: `Bearer ${TOKEN}` },
      { method: "POST", path: "/v1/channel", body: { channel: "preview" }, authorization: `Bearer ${TOKEN}` },
    ]);
    const entries = await getDb().select().from(auditLog).orderBy(auditLog.createdAt);
    expect(entries.map(({ action, summary }) => ({ action, summary }))).toEqual([
      { action: "updates.install", summary: "Started the installation of 0.2.1" },
      { action: "updates.channel", summary: "Switched updates to the Preview channel" },
    ]);
  });

  it("records nothing the updater did not take, and sends it no wrong version", async () => {
    const admin = await createUser("admin");
    const wrong = await request("POST", "/api/v1/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1\nversion=9.9.9" },
    });
    expect(wrong.status).toBe(400);
    expect(updater.calls).toEqual([]);

    updater.respond((call) =>
      call.path === "/v1/install"
        ? { status: 409, body: { error: "0.2.1 is being installed." } }
        : { body: updaterStatus() },
    );
    const refused = await request("POST", "/api/v1/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reachable: true, error: "0.2.1 is being installed." });

    // Without UPDATER_TOKEN, this updater refuses, and the answer says what to set.
    delete process.env.UPDATER_TOKEN;
    resetConfigForTests();
    const tokenless = await request("POST", "/api/v1/updates/channel", {
      userId: admin.id,
      body: { channel: "preview" },
    });
    expect(tokenless.status).toBe(409);
    expect(tokenless.body.error).toMatch(/UPDATER_TOKEN/);
    expect(updater.calls.at(-2)).toMatchObject({ path: "/v1/channel", authorization: null });

    // Without UPDATER_URL, the button is off and nothing is called.
    process.env.UPDATER_URL = "";
    resetConfigForTests();
    updater.calls.length = 0;
    const off = await request("POST", "/api/v1/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
    });
    expect(off).toMatchObject({ status: 200, body: { reachable: false, updater: null } });
    expect(updater.calls).toEqual([]);

    expect(await getDb().select().from(auditLog)).toEqual([]);
  });
});
