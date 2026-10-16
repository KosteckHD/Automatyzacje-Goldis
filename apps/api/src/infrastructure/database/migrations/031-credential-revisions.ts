import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("users", "credential_revision", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 1,
    }, { transaction });
    await context.addColumn("user_sessions", "credential_revision", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 1,
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE users ADD CONSTRAINT users_credential_revision_positive CHECK (credential_revision > 0);
       ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_credential_revision_positive CHECK (credential_revision > 0);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("user_sessions", "user_sessions_credential_revision_positive", { transaction });
    await context.removeConstraint("users", "users_credential_revision_positive", { transaction });
    await context.removeColumn("user_sessions", "credential_revision", { transaction });
    await context.removeColumn("users", "credential_revision", { transaction });
  });
}
