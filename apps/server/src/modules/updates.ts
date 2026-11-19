import { Hono, type Context } from "hono";
import {
  installUpdateSchema,
  setUpdateChannelSchema,
  type UpdatesResponse,
} from "@support-agent/shared/api/updates";
import { config } from "../config";
import { getDb } from "../db/client";
import { audit } from "../core/audit";
import type { AppEnv } from "../http/env";
import { jsonBody, requireAdmin } from "../http/middleware";
import { callUpdater, type UpdaterResult } from "../updater/client";

/**
 * The update button and the "Updates" settings: admin-only routes in front
 * of the updater. Every answer is an `UpdatesResponse`: 200 (202 when an
 * installation started); 409 with `error` and the latest status when the
 * updater refused; 200 with `reachable: false` when no updater answers.
 */
const router = new Hono<AppEnv>();

async function answer(c: Context<AppEnv>, result: UpdaterResult) {
  const app = { version: config().APP_VERSION ?? null };
  if (result.kind === "ok") {
    const body: UpdatesResponse = { app, reachable: true, updater: result.status, error: null };
    return c.json(body, result.httpStatus === 202 ? 202 : 200);
  }
  if (result.kind === "unreachable") {
    const body: UpdatesResponse = { app, reachable: false, updater: null, error: result.error };
    return c.json(body);
  }
  // The reason, with the status that explains it (e.g. an installation runs).
  const latest = await callUpdater("status");
  const body: UpdatesResponse = {
    app,
    reachable: true,
    updater: latest.kind === "ok" ? latest.status : null,
    error: result.error,
  };
  return c.json(body, 409);
}

router.get("/updates", async (c) => {
  requireAdmin(c);
  const result = await callUpdater("status");
  // The status never refuses; an error answer means no usable updater there.
  return answer(c, result.kind === "refused" ? { kind: "unreachable", error: result.error } : result);
});

router.post("/updates/check", async (c) => {
  requireAdmin(c);
  return answer(c, await callUpdater("check"));
});

router.post("/updates/install", async (c) => {
  const actor = requireAdmin(c);
  const { version } = await jsonBody(c, installUpdateSchema);
  const result = await callUpdater("install", { version });
  if (result.kind === "ok") {
    await audit(getDb(), actor, {
      action: "updates.install",
      entityType: "updates",
      summary: `Started the installation of ${version}`,
    });
  }
  return answer(c, result);
});

router.post("/updates/channel", async (c) => {
  const actor = requireAdmin(c);
  const { channel } = await jsonBody(c, setUpdateChannelSchema);
  const result = await callUpdater("channel", { channel });
  if (result.kind === "ok") {
    await audit(getDb(), actor, {
      action: "updates.channel",
      entityType: "updates",
      summary: `Switched updates to the ${channel === "preview" ? "Preview" : "Stable"} channel`,
    });
  }
  return answer(c, result);
});

export default router;
