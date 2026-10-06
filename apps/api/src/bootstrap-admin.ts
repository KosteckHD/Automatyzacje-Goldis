import { Injectable, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ImportBatch, Tenant, TenantMembership, User, sequelize } from "./db";
import { hashPassword } from "./password-hash";

@Injectable()
export class BootstrapAdminService implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    const username = process.env.GOLDIS_ADMIN_USER?.trim();
    const password = process.env.GOLDIS_ADMIN_PASSWORD;
    if (!username || username.length > 128 || !password || password.length > 1024) {
      throw new Error("BOOTSTRAP_ADMIN_CONFIG_INVALID");
    }

    try {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query("SELECT pg_advisory_xact_lock(72498231)", { transaction });
        if (await User.count({ transaction }) > 0) return;
        const tenant = await Tenant.findOne({ where: { slug: "goldis" }, transaction });
        if (!tenant) throw new Error("BOOTSTRAP_TENANT_MISSING");
        const now = new Date();
        const user = await User.create({
          userId: randomUUID(), username, usernameNormalized: username.toLowerCase(),
          passwordHash: await hashPassword(password), status: "active",
          createdAt: now, updatedAt: now, lastLoginAt: null,
        }, { transaction });
        await TenantMembership.create({
          tenantId: tenant.tenantId, userId: user.userId, role: "admin", status: "active",
          createdAt: now, updatedAt: now,
        }, { transaction });
        // The legacy app had exactly one bootstrap account, so its unowned imports belong to this first admin.
        await ImportBatch.update({ tenantId: tenant.tenantId, ownerUserId: user.userId }, {
          where: { tenantId: null, ownerUserId: null }, transaction,
        });
      });
    } catch {
      // Keep database errors and bootstrap credentials out of startup logs.
      throw new Error("BOOTSTRAP_ADMIN_FAILED");
    }
  }
}
