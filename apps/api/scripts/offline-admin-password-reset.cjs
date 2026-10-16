"use strict";

const { Buffer } = require("node:buffer");

function assertMaintenanceMode() {
  if (process.env.APP_ENV !== "production"
    || process.env.GOLDIS_OFFLINE_ADMIN_RECOVERY !== "VERIFIED_VPS_OPERATOR") {
    throw new Error("OFFLINE_ADMIN_RECOVERY_MAINTENANCE_CONFIRMATION_REQUIRED");
  }
  const url = new URL(process.env.DATABASE_URL || "");
  if (url.hostname !== "postgres" || url.port !== "5432" || url.pathname !== "/goldis" || url.search || url.hash) {
    throw new Error("OFFLINE_ADMIN_RECOVERY_LOCAL_DATABASE_REQUIRED");
  }
}

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("OFFLINE_ADMIN_RECOVERY_INTERACTIVE_TERMINAL_REQUIRED");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    let complete = false;
    const previousRaw = process.stdin.isRaw;
    const finish = (error) => {
      if (complete) return;
      complete = true;
      process.stdin.off("data", onData);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("OFFLINE_ADMIN_RECOVERY_CANCELLED"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (/[\u0000-\u001f\u007f]/.test(character)) continue;
        value += character;
        if (Buffer.byteLength(value, "utf8") > 4_096) return finish(new Error("OFFLINE_ADMIN_RECOVERY_PASSWORD_TOO_LARGE"));
      }
    };
    process.stdout.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  assertMaintenanceMode();
  const username = process.argv[2];
  if (process.argv.length !== 3 || typeof username !== "string" || username.length > 128
    || username.trim() !== username || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error("OFFLINE_ADMIN_RECOVERY_USERNAME_REQUIRED");
  }
  const normalizedUsername = username.toLowerCase();
  const { sequelize, Tenant, TenantMembership, User } = require("../dist/infrastructure/database/db.js");
  const { hashPassword } = require("../dist/features/auth");
  const { passwordPolicyFailure } = require("../dist/features/auth");
  const { applyPasswordChange } = require("../dist/features/auth");
  const { lockUsersInTransaction } = require("../dist/contracts/user-serialization.js");
  const { revokeUserRecoveryTokens } = require("../dist/features/account-recovery/account-recovery-tokens.js");
  let password = "";
  let confirmation = "";
  try {
    const candidate = await User.findOne({ where: { usernameNormalized: normalizedUsername } });
    const tenant = await Tenant.findOne({ where: { slug: "goldis" } });
    const membership = candidate && tenant ? await TenantMembership.findOne({ where: {
      tenantId: tenant.tenantId, userId: candidate.userId, role: "admin", status: "active",
    } }) : null;
    if (!candidate || candidate.status !== "active" || !tenant || !membership) {
      throw new Error("OFFLINE_ADMIN_RECOVERY_ACTIVE_GOLDIS_ADMIN_REQUIRED");
    }

    password = await readHidden("Nowe hasło administratora (wpisywanie ukryte): ");
    const policyFailure = passwordPolicyFailure(password);
    if (policyFailure) throw new Error("OFFLINE_ADMIN_RECOVERY_PASSWORD_POLICY_FAILED");
    confirmation = await readHidden("Powtórz nowe hasło: ");
    if (password !== confirmation) throw new Error("OFFLINE_ADMIN_RECOVERY_PASSWORD_MISMATCH");
    confirmation = "";
    const passwordHash = await hashPassword(password);
    password = "";

    await sequelize.transaction(async (transaction) => {
      await lockUsersInTransaction([candidate.userId], transaction);
      const current = await User.findByPk(candidate.userId, { transaction, lock: transaction.LOCK.UPDATE });
      const activeTenant = await Tenant.findOne({ where: { slug: "goldis" }, transaction });
      const activeMembership = activeTenant ? await TenantMembership.findOne({ where: {
        tenantId: activeTenant.tenantId, userId: candidate.userId, role: "admin", status: "active",
      }, transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (!current || current.status !== "active" || !activeTenant || !activeMembership) {
        throw new Error("OFFLINE_ADMIN_RECOVERY_TARGET_CHANGED");
      }
      await applyPasswordChange({ user: current, tenantId: activeTenant.tenantId, actorUserId: null,
        passwordHash, mustChangePassword: false, reason: "offline_admin_recovery", transaction });
      await revokeUserRecoveryTokens(current.userId, transaction, new Date());
    });
    process.stdout.write("OFFLINE_ADMIN_PASSWORD_RESET_COMPLETED sessions_and_recovery_links_revoked=true; sign_in_normally\n");
  } finally {
    password = "";
    confirmation = "";
    await sequelize.close();
  }
}

main().catch((error) => {
  const code = error instanceof Error && /^OFFLINE_ADMIN_RECOVERY_[A-Z0-9_]+$/.test(error.message)
    ? error.message : "OFFLINE_ADMIN_RECOVERY_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
