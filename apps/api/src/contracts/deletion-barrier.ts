import { QueryTypes, type Transaction } from "sequelize";
import { sequelize } from "../infrastructure/database/db";

export type TombstonedResourceType = "artifact" | "run" | "import" | "tenant";

/**
 * Small cross-feature contract for hiding resources as soon as a deletion is
 * admitted. Tombstones remain after physical deletion so stale IDs stay hidden.
 */
export async function isResourceTombstoned(
  resourceType: TombstonedResourceType,
  resourceId: string,
  transaction?: Transaction,
): Promise<boolean> {
  const rows = await sequelize.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM resource_tombstones
        WHERE resource_type = :resourceType AND resource_id = :resourceId
     ) AS exists`,
    { replacements: { resourceType, resourceId }, type: QueryTypes.SELECT, transaction },
  );
  return Boolean(rows[0]?.exists);
}

export function isRunDeletionPending(runId: string, transaction?: Transaction): Promise<boolean> {
  return isResourceTombstoned("run", runId, transaction);
}
