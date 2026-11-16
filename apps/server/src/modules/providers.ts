import { Hono } from "hono";
import { asc, eq, or, sql } from "drizzle-orm";
import {
  PROVIDER_LABELS,
  providerCreateSchema,
  providerTestInputSchema,
  providerUpdateSchema,
  type Provider,
  type ProviderKind,
} from "@support-agent/shared/api/providers";
import type { CheckResult } from "@support-agent/shared/api/common";
import { getDb, type DbOrTx } from "../db/client";
import { agents, providers } from "../db/schema";
import { encryptSecret, secretHint } from "../core/crypto";
import { audit } from "../core/audit";
import { notifyConfigChanged } from "../core/config-events";
import type { AppEnv } from "../http/env";
import { conflict, notFound } from "../http/errors";
import { idParam, jsonBody, requireAdmin, requireUser } from "../http/middleware";
import { providerConnection } from "../agent/runtime";
import { generateJson, llmClient, LlmError } from "../llm";
import { z } from "zod";
import { iso, isoRequired } from "./util";

type Row = typeof providers.$inferSelect;

async function agentCounts(db: DbOrTx): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: providers.id, count: sql<number>`count(${agents.id})::int` })
    .from(providers)
    .leftJoin(agents, or(eq(agents.providerId, providers.id), eq(agents.fallbackProviderId, providers.id)))
    .groupBy(providers.id);
  return new Map(rows.map((row) => [row.id, row.count]));
}

function toProvider(row: Row, count: number): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKeyEncrypted),
    apiKeyHint: row.apiKeyEncrypted ? row.apiKeyHint : null,
    agentCount: count,
    createdAt: isoRequired(row.createdAt),
    updatedAt: iso(row.updatedAt)!,
  };
}

async function load(db: DbOrTx, id: string): Promise<Row> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id));
  if (!row) throw notFound("Provider not found");
  return row;
}

const router = new Hono<AppEnv>();

router.get("/providers", async (c) => {
  requireUser(c);
  const db = getDb();
  const [rows, counts] = await Promise.all([
    db.select().from(providers).orderBy(asc(providers.name)),
    agentCounts(db),
  ]);
  return c.json({ items: rows.map((row) => toProvider(row, counts.get(row.id) ?? 0)) });
});

router.post("/providers", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, providerCreateSchema);
  const row = await getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(providers)
      .values({
        name: input.name,
        kind: input.kind,
        baseUrl: input.baseUrl ?? null,
        apiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
        apiKeyHint: input.apiKey ? secretHint(input.apiKey) : null,
      })
      .returning();
    await audit(tx, actor, {
      action: "provider.created",
      entityType: "provider",
      entityId: created!.id,
      summary: `Added provider "${input.name}" (${PROVIDER_LABELS[input.kind]})`,
    });
    return created!;
  });
  return c.json(toProvider(row, 0), 201);
});

router.patch("/providers/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  const input = await jsonBody(c, providerUpdateSchema);
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    const current = await load(tx, id);
    if (current.kind === "openai_compatible" && input.baseUrl === null) {
      throw conflict("An OpenAI-compatible provider needs a base URL");
    }
    if (current.kind !== "openai_compatible" && input.apiKey === null) {
      throw conflict("This provider needs an API key; enter a new one instead");
    }
    const changes: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) changes.name = input.name;
    if (input.baseUrl !== undefined) changes.baseUrl = input.baseUrl;
    if (input.apiKey !== undefined) {
      changes.apiKeyEncrypted = input.apiKey ? encryptSecret(input.apiKey) : null;
      changes.apiKeyHint = input.apiKey ? secretHint(input.apiKey) : null;
    }
    const [updated] = await tx.update(providers).set(changes).where(eq(providers.id, id)).returning();
    await audit(tx, actor, {
      action: "provider.updated",
      entityType: "provider",
      entityId: id,
      summary: `Changed provider "${updated!.name}"${input.apiKey !== undefined ? " (API key replaced)" : ""}`,
    });
    await notifyConfigChanged(tx);
    return updated!;
  });
  const counts = await agentCounts(db);
  return c.json(toProvider(row, counts.get(id) ?? 0));
});

router.delete("/providers/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  await getDb().transaction(async (tx) => {
    const current = await load(tx, id);
    const [used] = await tx
      .select({ name: agents.name })
      .from(agents)
      .where(or(eq(agents.providerId, id), eq(agents.fallbackProviderId, id)))
      .limit(1);
    if (used)
      throw conflict(`The agent "${used.name}" uses this provider. Choose another provider there first.`);
    await tx.delete(providers).where(eq(providers.id, id));
    await audit(tx, actor, {
      action: "provider.deleted",
      entityType: "provider",
      entityId: id,
      summary: `Deleted provider "${current.name}"`,
    });
  });
  return c.json({ ok: true });
});

router.get("/providers/:id/models", async (c) => {
  requireUser(c);
  const row = await load(getDb(), idParam(c));
  try {
    const models = await llmClient(providerConnection(row)).listModels();
    return c.json({ models });
  } catch (error) {
    // Not every compatible API lists its models; people can type the name instead.
    const message = error instanceof LlmError ? error.message : "Could not list the models";
    return c.json({ error: { code: "provider_error", message } }, 502);
  }
});

router.post("/providers/:id/test", async (c) => {
  requireAdmin(c);
  const row = await load(getDb(), idParam(c));
  const { model } = await jsonBody(c, providerTestInputSchema);
  const started = performance.now();
  let result: CheckResult;
  try {
    const reply = await generateJson(
      llmClient(providerConnection(row)),
      {
        model,
        system: "You check that a model connection works.",
        messages: [{ role: "user", content: [{ type: "text", text: 'Reply with {"ok": true}.' }] }],
        schemaName: "check",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      z.object({ ok: z.boolean() }),
    );
    result = {
      ok: true,
      message: `The model answered (${reply.inputTokens + reply.outputTokens} tokens)`,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof LlmError ? error.message : "The model call failed",
      latencyMs: Math.round(performance.now() - started),
    };
  }
  return c.json(result);
});

export default router;
