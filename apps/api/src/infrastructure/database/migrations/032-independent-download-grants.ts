import type { QueryInterface } from "sequelize";

/** Downloading a known artifact is a separate capability from reading application data. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE tool_grants DROP CONSTRAINT tool_grants_implications;
       ALTER TABLE tool_grants ADD CONSTRAINT tool_grants_execute_implies_discover
         CHECK (NOT can_execute OR can_discover);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    // Restore the legacy implication before re-adding the old constraint.
    await context.sequelize.query(
      `UPDATE tool_grants SET can_view_results = TRUE
        WHERE can_download_results = TRUE AND can_view_results = FALSE;
       ALTER TABLE tool_grants DROP CONSTRAINT tool_grants_execute_implies_discover;
       ALTER TABLE tool_grants ADD CONSTRAINT tool_grants_implications
         CHECK ((NOT can_execute OR can_discover) AND (NOT can_download_results OR can_view_results));`,
      { transaction },
    );
  });
}
