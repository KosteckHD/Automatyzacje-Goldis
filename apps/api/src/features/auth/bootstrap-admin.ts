import { randomUUID } from "node:crypto";
import type { BootstrapAdminRuntimeConfig } from "../../infrastructure/config";
import { ImportBatch, sequelize, Tenant, TenantMembership, User } from "../../infrastructure/database/db";
import { containsControlCharacters } from "../../shared/control-characters";
import { hashPassword, passwordPolicyFailure } from "./";

export async function bootstrapAdminOnce(config: BootstrapAdminRuntimeConfig): Promise<void> {
  const isSeeded = await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT pg_advisory_xact_lock(72498231)", { transaction });
    return (await User.count({ transaction })) > 0;
  });
  if (isSeeded) return;
  const username = config.username?.trim();
  const password = config.password;
  if (
    !username ||
    username.length > 128 ||
    containsControlCharacters(username) ||
    !password ||
    passwordPolicyFailure(password)
  ) {
    throw new Error("BOOTSTRAP_ADMIN_CONFIG_INVALID");
  }
  const passwordHash = await hashPassword(password);
  try {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT pg_advisory_xact_lock(72498231)", { transaction });
      if ((await User.count({ transaction })) > 0) return;
      const tenant = await Tenant.findOne({ where: { slug: "goldis" }, transaction });
      if (!tenant) throw new Error("BOOTSTRAP_TENANT_MISSING");
      const now = new Date();
      const user = await User.create(
        {
          userId: randomUUID(),
          username,
          usernameNormalized: username.toLowerCase(),
          passwordHash,
          status: "active",
          mustChangePassword: true,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null,
        },
        { transaction },
      );
      await TenantMembership.create(
        {
          tenantId: tenant.tenantId,
          userId: user.userId,
          role: "admin",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        { transaction },
      );
      // The legacy app had exactly one bootstrap account, so its unowned imports belong to this first admin.
      await ImportBatch.update(
        { tenantId: tenant.tenantId, ownerUserId: user.userId },
        {
          where: { tenantId: null, ownerUserId: null },
          transaction,
        },
      );
    });
  } catch {
    // Keep database errors and bootstrap credentials out of startup logs.
    throw new Error("BOOTSTRAP_ADMIN_FAILED");
  }
}
