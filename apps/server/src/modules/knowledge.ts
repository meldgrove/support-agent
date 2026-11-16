import { Hono } from "hono";
import { asc, eq, sql } from "drizzle-orm";
import {
  knowledgeSourceCreateSchema,
  knowledgeSourceUpdateSchema,
  knowledgeTestInputSchema,
  type KnowledgeSource,
  type KnowledgeTestResult,
} from "@support-agent/shared/api/knowledge";
import { getDb, type DbOrTx } from "../db/client";
import { agentKnowledgeSources, agents, knowledgeSources } from "../db/schema";
import { encryptSecret } from "../core/crypto";
import { audit } from "../core/audit";
import { notifyConfigChanged } from "../core/config-events";
import type { AppEnv } from "../http/env";
import { conflict, notFound } from "../http/errors";
import { idParam, jsonBody, requireAdmin, requireUser } from "../http/middleware";
import { sourceConnection } from "../agent/runtime";
import { searchSource, SearchError } from "../knowledge/search-api";
import { isoRequired } from "./util";

type Row = typeof knowledgeSources.$inferSelect;

async function agentCounts(db: DbOrTx): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: agentKnowledgeSources.knowledgeSourceId, count: sql<number>`count(*)::int` })
    .from(agentKnowledgeSources)
    .groupBy(agentKnowledgeSources.knowledgeSourceId);
  return new Map(rows.map((row) => [row.id, row.count]));
}

function toSource(row: Row, count: number): KnowledgeSource {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: "search_api",
    config: row.config,
    hasSecret: Boolean(row.secretEncrypted),
    agentCount: count,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

async function load(db: DbOrTx, id: string): Promise<Row> {
  const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
  if (!row) throw notFound("Knowledge source not found");
  return row;
}

const router = new Hono<AppEnv>();

router.get("/knowledge-sources", async (c) => {
  requireUser(c);
  const db = getDb();
  const [rows, counts] = await Promise.all([
    db.select().from(knowledgeSources).orderBy(asc(knowledgeSources.name)),
    agentCounts(db),
  ]);
  return c.json({ items: rows.map((row) => toSource(row, counts.get(row.id) ?? 0)) });
});

router.post("/knowledge-sources", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, knowledgeSourceCreateSchema);
  const row = await getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(knowledgeSources)
      .values({
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        config: input.config,
        secretEncrypted: input.secret ? encryptSecret(input.secret) : null,
      })
      .returning();
    await audit(tx, actor, {
      action: "knowledge_source.created",
      entityType: "knowledge_source",
      entityId: created!.id,
      summary: `Added knowledge source "${input.name}"`,
    });
    return created!;
  });
  return c.json(toSource(row, 0), 201);
});

router.patch("/knowledge-sources/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  const input = await jsonBody(c, knowledgeSourceUpdateSchema);
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    await load(tx, id);
    const changes: Partial<typeof knowledgeSources.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) changes.name = input.name;
    if (input.description !== undefined) changes.description = input.description;
    if (input.config !== undefined) changes.config = input.config;
    if (input.secret !== undefined)
      changes.secretEncrypted = input.secret ? encryptSecret(input.secret) : null;
    const [updated] = await tx
      .update(knowledgeSources)
      .set(changes)
      .where(eq(knowledgeSources.id, id))
      .returning();
    await audit(tx, actor, {
      action: "knowledge_source.updated",
      entityType: "knowledge_source",
      entityId: id,
      summary: `Changed knowledge source "${updated!.name}"${input.secret !== undefined ? " (secret replaced)" : ""}`,
    });
    await notifyConfigChanged(tx);
    return updated!;
  });
  const counts = await agentCounts(db);
  return c.json(toSource(row, counts.get(id) ?? 0));
});

router.delete("/knowledge-sources/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  await getDb().transaction(async (tx) => {
    const current = await load(tx, id);
    const [used] = await tx
      .select({ name: agents.name })
      .from(agentKnowledgeSources)
      .innerJoin(agents, eq(agents.id, agentKnowledgeSources.agentId))
      .where(eq(agentKnowledgeSources.knowledgeSourceId, id))
      .limit(1);
    if (used) throw conflict(`The agent "${used.name}" uses this knowledge source. Remove it there first.`);
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
    await audit(tx, actor, {
      action: "knowledge_source.deleted",
      entityType: "knowledge_source",
      entityId: id,
      summary: `Deleted knowledge source "${current.name}"`,
    });
  });
  return c.json({ ok: true });
});

router.post("/knowledge-sources/:id/test", async (c) => {
  requireUser(c);
  const row = await load(getDb(), idParam(c));
  const { query } = await jsonBody(c, knowledgeTestInputSchema);
  const started = performance.now();
  let result: KnowledgeTestResult;
  try {
    const results = await searchSource(sourceConnection(row), query);
    result = {
      ok: true,
      message: results.length === 1 ? "1 result" : `${results.length} results`,
      latencyMs: Math.round(performance.now() - started),
      results,
    };
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof SearchError ? error.message : "The search failed",
      latencyMs: Math.round(performance.now() - started),
      results: [],
    };
  }
  return c.json(result);
});

export default router;
