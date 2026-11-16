import { Hono } from "hono";
import { appSettingsSchema } from "@support-agent/shared/api/settings";
import { getDb } from "../db/client";
import { audit } from "../core/audit";
import { notifyConfigChanged } from "../core/config-events";
import { getAppSettings, putSetting } from "../core/settings";
import type { AppEnv } from "../http/env";
import { jsonBody, requireAdmin, requireUser } from "../http/middleware";

const router = new Hono<AppEnv>();

router.get("/settings", async (c) => {
  requireUser(c);
  return c.json(await getAppSettings(getDb()));
});

router.put("/settings", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, appSettingsSchema);
  await getDb().transaction(async (tx) => {
    await putSetting(tx, "app", input);
    await audit(tx, actor, {
      action: "settings.updated",
      entityType: "settings",
      summary: "Changed the settings",
    });
    await notifyConfigChanged(tx);
  });
  return c.json(input);
});

export default router;
