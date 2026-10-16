import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("manual_interventions", "assignee_user_id", {
      type: DataTypes.UUID, allowNull: true,
      references: { model: "users", key: "user_id" }, onDelete: "SET NULL",
    }, { transaction });
    await context.addColumn("manual_interventions", "priority", {
      type: DataTypes.STRING(12), allowNull: false, defaultValue: "normal",
    }, { transaction });
    await context.addColumn("manual_interventions", "due_at", {
      type: DataTypes.DATE, allowNull: true,
    }, { transaction });
    await context.addColumn("manual_interventions", "assigned_at", {
      type: DataTypes.DATE, allowNull: true,
    }, { transaction });
    await context.addColumn("manual_interventions", "assigned_by", {
      type: DataTypes.UUID, allowNull: true,
      references: { model: "users", key: "user_id" }, onDelete: "SET NULL",
    }, { transaction });
    await context.createTable("intervention_activity", {
      activity_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      intervention_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "manual_interventions", key: "intervention_id" }, onDelete: "CASCADE",
      },
      actor_user_id: { type: DataTypes.UUID, allowNull: false,
        references: { model: "users", key: "user_id" }, onDelete: "RESTRICT" },
      event_type: { type: DataTypes.STRING(24), allowNull: false },
      previous_assignee_user_id: { type: DataTypes.UUID, allowNull: true,
        references: { model: "users", key: "user_id" }, onDelete: "SET NULL" },
      next_assignee_user_id: { type: DataTypes.UUID, allowNull: true,
        references: { model: "users", key: "user_id" }, onDelete: "SET NULL" },
      priority: { type: DataTypes.STRING(12), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE manual_interventions
         ADD CONSTRAINT manual_interventions_priority_valid CHECK (priority IN ('normal', 'high')),
         ADD CONSTRAINT manual_interventions_assigned_pair CHECK
           ((assignee_user_id IS NULL) = (assigned_at IS NULL));
       ALTER TABLE intervention_activity
         ADD CONSTRAINT intervention_activity_event_valid CHECK
           (event_type IN ('assigned', 'unassigned', 'priority_changed', 'resolved')),
         ADD CONSTRAINT intervention_activity_priority_valid CHECK
           (priority IS NULL OR priority IN ('normal', 'high'));
       CREATE INDEX manual_interventions_assignment_idx
         ON manual_interventions (status, assignee_user_id, priority, created_at DESC);
       CREATE INDEX intervention_activity_timeline_idx
         ON intervention_activity (intervention_id, created_at DESC, activity_id DESC);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("intervention_activity", { transaction });
    await context.removeIndex("manual_interventions", "manual_interventions_assignment_idx", { transaction });
    await context.removeColumn("manual_interventions", "assigned_by", { transaction });
    await context.removeColumn("manual_interventions", "assigned_at", { transaction });
    await context.removeColumn("manual_interventions", "due_at", { transaction });
    await context.removeColumn("manual_interventions", "priority", { transaction });
    await context.removeColumn("manual_interventions", "assignee_user_id", { transaction });
  });
}
