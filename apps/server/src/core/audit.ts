import type { DbOrTx } from "../db/client";
import { auditLog } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";

/** Records a change made in the admin interface. `summary` must never contain secrets. */
export async function audit(
  db: DbOrTx,
  actor: UserPrincipal | null,
  entry: { action: string; entityType: string; entityId?: string | null; summary: string },
) {
  await db.insert(auditLog).values({
    actorUserId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary.slice(0, 500),
  });
}
