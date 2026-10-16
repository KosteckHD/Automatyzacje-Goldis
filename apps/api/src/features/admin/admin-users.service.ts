import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { containsControlCharacters } from "../../shared/control-characters";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { applyPasswordChange, hashPassword, passwordPolicyFailure } from "../auth";
import { runConfirmedPrivilegedAction } from "../privileged-actions/public";
import { uuidPattern } from "./admin.support";
import { AdminMutationsService } from "./admin-mutations.service";
import type {
  AdminCreateUserInput,
  AdminRevokeToolGrantInput,
  AdminSetDeletionGrantInput,
  AdminSetToolGrantInput,
  AdminUserRole,
} from "./admin-users.dto";
import { AdminUsersRepository } from "./admin-users.repository";

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(AdminUsersRepository) private readonly repository: AdminUsersRepository,
    @Inject(AdminMutationsService) private readonly mutations: AdminMutationsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createUser(actor: SessionPrincipal, input: AdminCreateUserInput) {
    const username = input.username.trim();
    if (
      !username ||
      username.length > 128 ||
      containsControlCharacters(username) ||
      passwordPolicyFailure(input.password)
    ) {
      throw new BadRequestException("Login lub hasło nie spełnia wymagań");
    }
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.repository.transaction(async (transaction) =>
        runConfirmedPrivilegedAction(
          {
            actor,
            action: "admin.user.create",
            targetId: null,
            payload: { username, password: input.password, role: input.role },
            token: input.confirmationToken,
            idempotencyKey: input.idempotencyKey,
            transaction,
          },
          async () => {
            await this.mutations.lockTenantAdminChanges(actor, transaction);
            const user = await this.repository.createUser({
              userId: randomUUID(),
              tenantId: actor.tenantId,
              username,
              usernameNormalized: username.toLowerCase(),
              passwordHash,
              role: input.role,
              now: new Date(),
              transaction,
            });
            await this.audit.record(
              {
                tenantId: actor.tenantId,
                actorUserId: actor.userId,
                action: "user.created",
                resourceType: "user",
                resourceId: user.userId,
                outcome: "succeeded",
                metadata: { role: input.role },
              },
              transaction,
            );
            return { ...user, role: input.role };
          },
        ),
      );
    } catch (error) {
      if ((error as { name?: string }).name === "SequelizeUniqueConstraintError")
        throw new ConflictException("Login jest już zajęty");
      throw error;
    }
  }

  async grants(actor: SessionPrincipal, userId: string) {
    const member = await this.repository.findGrantMeta(actor.tenantId, userId);
    if (!member) throw new NotFoundException();
    const tools = await this.repository.listToolGrants(actor.tenantId, userId);
    return {
      userId,
      role: member.role,
      canDeleteData: member.canDeleteData,
      deletionGrantVersion: member.deletionGrantVersion,
      items: tools.map((tool) => ({
        ...tool,
        canDiscover: Boolean(tool.canDiscover),
        canExecute: Boolean(tool.canExecute),
        canViewResults: Boolean(tool.canViewResults),
        canDownloadResults: Boolean(tool.canDownloadResults),
        version: tool.version ?? 0,
      })),
    };
  }

  async setToolGrant(actor: SessionPrincipal, userId: string, toolId: string, input: AdminSetToolGrantInput) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.grant.set",
          targetId: `${userId}/${toolId}`,
          payload: {
            canDiscover: input.canDiscover,
            canExecute: input.canExecute,
            canViewResults: input.canViewResults,
            canDownloadResults: input.canDownloadResults,
            expectedVersion: input.expectedVersion,
          },
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [userId]);
          const member = await this.repository.findMembershipForUpdate(actor.tenantId, userId, transaction);
          const tool = await this.repository.findTool(toolId, transaction);
          if (member?.status !== "active" || !tool) throw new NotFoundException();
          const existing = await this.repository.findToolGrantForUpdate(actor.tenantId, userId, toolId, transaction);
          if ((existing?.version ?? 0) !== input.expectedVersion)
            throw new ConflictException("Uprawnienia zmieniły się w innej sesji");
          const previous = existing
            ? { canViewResults: existing.canViewResults, canExecute: existing.canExecute }
            : { canViewResults: false, canExecute: false };
          const now = new Date();
          const saved = await this.repository.saveToolGrant({
            existing,
            tenantId: actor.tenantId,
            userId,
            toolId,
            actorUserId: actor.userId,
            canDiscover: input.canDiscover,
            canExecute: input.canExecute,
            canViewResults: input.canViewResults,
            canDownloadResults: input.canDownloadResults,
            version: input.expectedVersion + 1,
            now,
            transaction,
          });
          const lostView = previous.canViewResults && !input.canViewResults;
          const lostExecute = previous.canExecute && !input.canExecute;
          const unassignedInterventions =
            lostView || lostExecute
              ? await this.mutations.unassignIneligibleInterventions({
                  tenantId: actor.tenantId,
                  userId,
                  actorUserId: actor.userId,
                  transaction,
                })
              : 0;
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: existing ? "tool.grant.updated" : "tool.grant.created",
              resourceType: "tool",
              resourceId: toolId,
              outcome: "succeeded",
              metadata: {
                userId,
                beforeCanViewResults: previous.canViewResults,
                beforeCanExecute: previous.canExecute,
                afterCanViewResults: input.canViewResults,
                afterCanExecute: input.canExecute,
                version: saved.version,
                unassignedInterventions,
              },
            },
            transaction,
          );
          return {
            userId,
            toolId,
            canDiscover: input.canDiscover,
            canExecute: input.canExecute,
            canViewResults: input.canViewResults,
            canDownloadResults: input.canDownloadResults,
            version: saved.version,
            unassignedInterventions,
          };
        },
      ),
    );
  }

  async setDeletionGrant(actor: SessionPrincipal, userId: string, input: AdminSetDeletionGrantInput) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.deletion-grant",
          targetId: userId,
          payload: { canDeleteData: input.canDeleteData, expectedVersion: input.expectedVersion },
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [userId]);
          const member = await this.repository.findDeletionGrantForUpdate(actor.tenantId, userId, transaction);
          if (!member) throw new NotFoundException();
          if (input.canDeleteData && (member.role !== "manager" || member.status !== "active"))
            throw new BadRequestException("Grant usuwania danych można nadać wyłącznie aktywnemu Menedżerowi");
          if (member.deletionGrantVersion !== input.expectedVersion)
            throw new ConflictException("Grant usuwania zmienił się w innej sesji");
          if (member.canDeleteData === input.canDeleteData)
            return { userId, canDeleteData: input.canDeleteData, version: member.deletionGrantVersion };
          if (member.deletionGrantVersion >= 2_147_483_647) throw new ServiceUnavailableException();
          const version = member.deletionGrantVersion + 1;
          await this.repository.updateDeletionGrant(
            actor.tenantId,
            userId,
            input.canDeleteData,
            version,
            new Date(),
            transaction,
          );
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "user.deletion_grant.updated",
              resourceType: "user",
              resourceId: userId,
              outcome: "succeeded",
              metadata: { before: member.canDeleteData, after: input.canDeleteData, version },
            },
            transaction,
          );
          return { userId, canDeleteData: input.canDeleteData, version };
        },
      ),
    );
  }

  async revokeToolGrant(actor: SessionPrincipal, userId: string, toolId: string, input: AdminRevokeToolGrantInput) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.grant.revoke",
          targetId: `${userId}/${toolId}`,
          payload: { expectedVersion: input.expectedVersion },
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [userId]);
          const member = await this.repository.findMembershipForUpdate(actor.tenantId, userId, transaction);
          const tool = await this.repository.findTool(toolId, transaction);
          if (!member || !tool) throw new NotFoundException();
          const grant = await this.repository.findToolGrantForUpdate(actor.tenantId, userId, toolId, transaction);
          if ((grant?.version ?? 0) !== input.expectedVersion)
            throw new ConflictException("Uprawnienia zmieniły się w innej sesji");
          await this.repository.deleteToolGrant(actor.tenantId, userId, toolId, transaction);
          const unassignedInterventions = await this.mutations.unassignIneligibleInterventions({
            tenantId: actor.tenantId,
            userId,
            actorUserId: actor.userId,
            transaction,
          });
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "tool.grant.revoked",
              resourceType: "tool",
              resourceId: toolId,
              outcome: "succeeded",
              metadata: { userId, existed: Boolean(grant), unassignedInterventions },
            },
            transaction,
          );
          return { userId, toolId, revoked: Boolean(grant), unassignedInterventions };
        },
      ),
    );
  }

  async sessions(actor: SessionPrincipal, userId: string) {
    if (!(await this.repository.userExistsInTenant(actor.tenantId, userId))) throw new NotFoundException();
    const sessions = await this.repository.listSessions(actor.tenantId, userId);
    return {
      items: sessions.map((session) => ({ ...session, isCurrent: session.sessionId === actor.sessionId })),
    };
  }

  async revokeSession(
    actor: SessionPrincipal,
    input: {
      userId: string;
      sessionId: string;
      confirmationToken: unknown;
      idempotencyKey: unknown;
    },
  ) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.session.revoke",
          targetId: `${input.userId}/${input.sessionId}`,
          payload: {},
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [input.userId]);
          const member = await this.repository.findMembership(actor.tenantId, input.userId, transaction);
          if (!member) throw new NotFoundException();
          const now = new Date();
          const count = await this.repository.revokeSession({
            tenantId: actor.tenantId,
            userId: input.userId,
            sessionId: input.sessionId,
            actorUserId: actor.userId,
            now,
            transaction,
          });
          if (!count) throw new NotFoundException("Aktywna sesja nie istnieje");
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "session.revoked",
              resourceType: "session",
              resourceId: input.sessionId,
              outcome: "succeeded",
              metadata: { revokedByAdmin: true },
            },
            transaction,
          );
          return { sessionId: input.sessionId, revoked: true, currentSession: input.sessionId === actor.sessionId };
        },
      ),
    );
  }

  async revokeSessions(
    actor: SessionPrincipal,
    input: {
      userId: string;
      confirmationToken: unknown;
      idempotencyKey: unknown;
    },
  ) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.sessions.revoke",
          targetId: input.userId,
          payload: {},
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [input.userId]);
          const member = await this.repository.findMembership(actor.tenantId, input.userId, transaction, true);
          if (!member) throw new NotFoundException();
          const now = new Date();
          const count = await this.repository.revokeActiveSessions({
            tenantId: actor.tenantId,
            userId: input.userId,
            actorUserId: actor.userId,
            now,
            transaction,
          });
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "session.revoked",
              resourceType: "user",
              resourceId: input.userId,
              outcome: "succeeded",
              metadata: { count },
            },
            transaction,
          );
          return { revokedCount: count };
        },
      ),
    );
  }

  async setUserStatus(
    actor: SessionPrincipal,
    input: {
      userId: string;
      status: "active" | "disabled";
      confirmationToken: unknown;
      idempotencyKey: unknown;
    },
  ) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.status",
          targetId: input.userId,
          payload: { status: input.status },
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [input.userId]);
          const member = await this.repository.findMembershipForUpdate(actor.tenantId, input.userId, transaction);
          if (!member) throw new NotFoundException();
          if (input.status === "disabled") {
            if (member.role === "admin" && member.status === "active") {
              const otherAdmins = await this.repository.countOtherActiveAdmins(
                actor.tenantId,
                input.userId,
                transaction,
              );
              if (otherAdmins < 1)
                throw new ConflictException("Organizacja musi mieć co najmniej jednego aktywnego administratora");
            }
            const now = new Date();
            await this.mutations.clearDeletionGrantForMembership(actor.tenantId, input.userId, transaction);
            await this.repository.saveMembershipStatus(member, "disabled", now, transaction);
            const user = await this.repository.findUserForUpdate(input.userId, transaction);
            if (user) await this.repository.saveUserStatus(user, "disabled", now, transaction);
            const revokedSessions = await this.repository.revokeAccountSessions(
              input.userId,
              actor.userId,
              now,
              transaction,
            );
            if (revokedSessions)
              await this.audit.record(
                {
                  tenantId: actor.tenantId,
                  actorUserId: actor.userId,
                  action: "session.revoked",
                  resourceType: "user",
                  resourceId: input.userId,
                  outcome: "succeeded",
                  metadata: { count: revokedSessions, reason: "account_change" },
                },
                transaction,
              );
            const unassignedInterventions = await this.mutations.unassignOpenInterventions({
              tenantId: actor.tenantId,
              userId: input.userId,
              actorUserId: actor.userId,
              transaction,
            });
            await this.audit.record(
              {
                tenantId: actor.tenantId,
                actorUserId: actor.userId,
                action: "user.updated",
                resourceType: "user",
                resourceId: input.userId,
                outcome: "succeeded",
                metadata: { status: "disabled", unassignedInterventions },
              },
              transaction,
            );
            return { userId: input.userId, status: "disabled" as const };
          }
          const user = await this.repository.findUserForUpdate(input.userId, transaction);
          if (!user) throw new NotFoundException();
          await this.repository.saveMembershipStatus(member, "active", new Date(), transaction);
          await this.repository.saveUserStatus(user, "active", new Date(), transaction);
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "user.updated",
              resourceType: "user",
              resourceId: input.userId,
              outcome: "succeeded",
              metadata: { status: "active" },
            },
            transaction,
          );
          return { userId: input.userId, status: "active" as const };
        },
      ),
    );
  }

  async updateRole(
    actor: SessionPrincipal,
    input: {
      userId: string;
      role: AdminUserRole;
      confirmationToken: unknown;
      idempotencyKey: unknown;
    },
  ) {
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.role",
          targetId: input.userId,
          payload: { role: input.role },
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [input.userId]);
          const member = await this.repository.findMembershipForUpdate(actor.tenantId, input.userId, transaction);
          if (!member) throw new NotFoundException();
          if (member.role === "admin" && input.role !== "admin" && member.status === "active") {
            const otherAdmins = await this.repository.countOtherActiveAdmins(actor.tenantId, input.userId, transaction);
            if (otherAdmins < 1)
              throw new ConflictException("Organizacja musi mieć co najmniej jednego aktywnego administratora");
          }
          const oldRole = member.role;
          if (input.role !== "manager")
            await this.mutations.clearDeletionGrantForMembership(actor.tenantId, input.userId, transaction);
          const now = new Date();
          await this.repository.saveMembershipRole(member, input.role, now, transaction);
          const revokedSessions = await this.repository.revokeTenantSessions(
            actor.tenantId,
            input.userId,
            actor.userId,
            now,
            transaction,
          );
          if (revokedSessions)
            await this.audit.record(
              {
                tenantId: actor.tenantId,
                actorUserId: actor.userId,
                action: "session.revoked",
                resourceType: "user",
                resourceId: input.userId,
                outcome: "succeeded",
                metadata: { count: revokedSessions, reason: "role_change" },
              },
              transaction,
            );
          const unassignedInterventions =
            oldRole !== input.role
              ? await this.mutations.unassignIneligibleInterventions({
                  tenantId: actor.tenantId,
                  userId: input.userId,
                  actorUserId: actor.userId,
                  role: input.role,
                  transaction,
                })
              : 0;
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: "user.updated",
              resourceType: "user",
              resourceId: input.userId,
              outcome: "succeeded",
              metadata: { oldRole, role: input.role, unassignedInterventions },
            },
            transaction,
          );
          return { userId: input.userId, role: member.role, unassignedInterventions };
        },
      ),
    );
  }

  async resetPassword(
    actor: SessionPrincipal,
    input: {
      userId: string;
      temporaryPassword: string;
      confirmationToken: unknown;
      idempotencyKey: unknown;
    },
  ) {
    if (passwordPolicyFailure(input.temporaryPassword))
      throw new BadRequestException("Hasło tymczasowe nie spełnia wymagań");
    const passwordHash = await hashPassword(input.temporaryPassword);
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor,
          action: "admin.user.password",
          targetId: input.userId,
          payload: { temporaryPassword: input.temporaryPassword },
          token: input.confirmationToken,
          idempotencyKey: input.idempotencyKey,
          transaction,
        },
        async () => {
          await this.mutations.lockTenantAdminChanges(actor, transaction, [input.userId]);
          const member = await this.repository.findMembership(actor.tenantId, input.userId, transaction);
          const user = await this.repository.findUserForUpdate(input.userId, transaction);
          if (!member || !user) throw new NotFoundException();
          await applyPasswordChange({
            user,
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            passwordHash,
            mustChangePassword: true,
            reason: "administrator_reset",
            transaction,
            audit: this.audit,
          });
          return { userId: input.userId, mustChangePassword: true };
        },
      ),
    );
  }

  async list(actor: SessionPrincipal, input: { limit: number; cursor?: string; query?: string }) {
    const query = (input.query ?? "").trim().toLowerCase();
    if (query.length > 128 || containsControlCharacters(query))
      throw new BadRequestException("Nieprawidłowe wyszukiwanie użytkowników");
    const filterHash = createHash("sha256").update(query).digest("hex");
    let before: { createdAt: Date; userId: string } | null = null;
    if (input.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (
          typeof decoded.createdAt !== "string" ||
          !Number.isFinite(Date.parse(decoded.createdAt)) ||
          typeof decoded.userId !== "string" ||
          !uuidPattern.test(decoded.userId) ||
          (decoded.filterHash !== filterHash && !(query === "" && decoded.filterHash === undefined))
        )
          throw new Error();
        before = { createdAt: new Date(decoded.createdAt), userId: decoded.userId };
      } catch {
        throw new BadRequestException("Nieprawidłowy kursor użytkowników");
      }
    }
    const rows = await this.repository.listPage({
      tenantId: actor.tenantId,
      query,
      before,
      fetchLimit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), userId: last.userId, filterHash }),
            ).toString("base64url")
          : null,
    };
  }
}
