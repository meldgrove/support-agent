import { Hono, type Context } from "hono";
import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import { config } from "../config";
import { getDb } from "../db/client";
import { audit } from "../core/audit";
import type { AppEnv } from "../http/env";
import { requireAdmin } from "../http/middleware";
import { logger } from "../logger";

/**
 * The update button and the "Updates" settings: admin-only routes in front
 * of the Meldgrove Updater. The shared handler of @meldgrove/ui asks the
 * updater at UPDATER_URL with UPDATER_TOKEN and answers as the button expects
 * (docs/deployment.md, Automatic updates). The API's middleware has already
 * refused changes from other sites (sameOrigin). Installations and channel
 * switches the updater took go to the audit log.
 */
const updates = createUpdatesHandler(() => ({
  url: config().UPDATER_URL,
  token: config().UPDATER_TOKEN,
  appVersion: config().APP_VERSION ?? null,
  logger,
}));

const router = new Hono<AppEnv>();

router.get("/updates", (c) => {
  requireAdmin(c);
  return answer(c, updates.respond("status"));
});

router.post("/updates/check", (c) => {
  requireAdmin(c);
  return answer(c, updates.respond("check"));
});

router.post("/updates/install", (c) =>
  change(c, "install", (body) => `Started the installation of ${body.version}`),
);

router.post("/updates/channel", (c) =>
  change(
    c,
    "channel",
    (body) => `Switched updates to the ${body.channel === "preview" ? "Preview" : "Stable"} channel`,
  ),
);

/**
 * The handler's answer as the route's response. Returned as it is, it would
 * lose the headers that middleware set before the route (x-request-id).
 */
async function answer(c: Context<AppEnv>, pending: Response | Promise<Response>) {
  const response = await pending;
  return c.newResponse(response.body, response);
}

/**
 * Passes a change to the updater and records it when the updater took it:
 * an answer of 2xx from a reachable updater, without an error. The handler
 * reads a copy of the body; it has checked the body when it took the change.
 */
async function change(
  c: Context<AppEnv>,
  action: "install" | "channel",
  summary: (body: Record<string, unknown>) => string,
) {
  const actor = requireAdmin(c);
  const response = await updates.respond(action, c.req.raw.clone());
  if (response.ok) {
    const result = (await response.clone().json()) as { reachable?: boolean; error?: string | null };
    if (result.reachable && result.error === null) {
      await audit(getDb(), actor, {
        action: `updates.${action}`,
        entityType: "updates",
        summary: summary(await c.req.json()),
      });
    }
  }
  return answer(c, response);
}

export default router;
