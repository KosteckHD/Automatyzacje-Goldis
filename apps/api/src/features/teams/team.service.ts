import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Transaction } from "sequelize";
import { AuditService } from "../audit/public";
import { applyPasswordChange, hashPassword, passwordPolicyFailure, type SessionPrincipal } from "../auth";
import { runConfirmedPrivilegedAction } from "../privileged-actions/public";
import { TeamRepository } from "./team.repository";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toolId = "oc-policy-verification";

function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Nieprawidłowe dane żądania");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new BadRequestException("Nieznane pole żądania");
  return object;
}

function hasUnsupportedControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

@Injectable()
export class TeamService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TeamRepository) private readonly repository: TeamRepository,
  ) {}

  private async lockManagerChanges(
    current: SessionPrincipal,
    transaction: Transaction,
    targetUserIds: readonly string[] = [],
  ) {
    const { user, membership, session } = await this.repository.lockManagerChanges(current, transaction, targetUserIds);
    if (
      user?.status !== "active" ||
      !membership ||
      !session ||
      session.expiresAt.getTime() <= Date.now() ||
      session.credentialRevision !== user.credentialRevision
    ) {
      throw new ForbiddenException("Sesja lub uprawnienia nie są już aktywne");
    }
  }

  private async employeeMembership(current: SessionPrincipal, userId: string, transaction?: Transaction) {
    const membership = await this.repository.findEmployeeMembership(current.tenantId, userId, transaction);
    if (!membership) throw new NotFoundException("Nie znaleziono konta pracownika");
    return membership;
  }

  async list(current: SessionPrincipal, rawQuery = "") {
    const query = rawQuery.trim().toLowerCase();
    if (query.length > 128 || hasUnsupportedControlCharacters(query))
      throw new BadRequestException("Nieprawidłowe wyszukiwanie");
    const rows = await this.repository.listMembers(current.tenantId, toolId, query);
    return {
      items: rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
        lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt).toISOString() : null,
        activeSessionCount: Number(row.activeSessionCount),
        leadCount: Number(row.leadCount),
        canExecuteOc: Boolean(row.canExecuteOc),
      })),
    };
  }

  async create(current: SessionPrincipal, input: unknown) {
    const body = strictObject(input, ["username", "temporaryPassword", "confirmationToken", "idempotencyKey"]);
    if (typeof body.username !== "string" || typeof body.temporaryPassword !== "string")
      throw new BadRequestException("Podaj login i hasło tymczasowe");
    const username = body.username.trim();
    if (
      !username ||
      username.length > 128 ||
      hasUnsupportedControlCharacters(username) ||
      passwordPolicyFailure(body.temporaryPassword)
    ) {
      throw new BadRequestException("Login lub hasło nie spełnia wymagań");
    }
    const passwordHash = await hashPassword(body.temporaryPassword);
    try {
      return await this.repository.transaction(async (transaction) =>
        runConfirmedPrivilegedAction(
          {
            actor: current,
            action: "team.user.create",
            targetId: null,
            payload: { username, temporaryPassword: body.temporaryPassword as string },
            token: body.confirmationToken,
            idempotencyKey: body.idempotencyKey,
            transaction,
          },
          async () => {
            await this.lockManagerChanges(current, transaction);
            const now = new Date();
            const user = await this.repository.createUser(
              {
                userId: randomUUID(),
                username,
                usernameNormalized: username.toLowerCase(),
                passwordHash,
                status: "active",
                createdAt: now,
                updatedAt: now,
                lastLoginAt: null,
                mustChangePassword: true,
              },
              transaction,
            );
            await this.repository.createMembership(
              {
                tenantId: current.tenantId,
                userId: user.userId,
                role: "operator",
                status: "active",
                createdAt: now,
                updatedAt: now,
              },
              transaction,
            );
            await this.audit.record(
              {
                tenantId: current.tenantId,
                actorUserId: current.userId,
                action: "user.created",
                resourceType: "user",
                resourceId: user.userId,
                outcome: "succeeded",
                metadata: { role: "operator", createdByManager: current.role === "manager" },
              },
              transaction,
            );
            return {
              userId: user.userId,
              username: user.username,
              role: "operator",
              status: "active",
              mustChangePassword: true,
            };
          },
        ),
      );
    } catch (error) {
      if ((error as { name?: string }).name === "SequelizeUniqueConstraintError")
        throw new ConflictException("Login jest już zajęty");
      throw error;
    }
  }

  async setStatus(current: SessionPrincipal, userId: string, input: unknown) {
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator pracownika");
    const body = strictObject(input, ["status", "confirmationToken", "idempotencyKey"]);
    if (body.status !== "active" && body.status !== "disabled")
      throw new BadRequestException("Nieprawidłowy status konta");
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor: current,
          action: "team.user.status",
          targetId: userId,
          payload: { status: body.status },
          token: body.confirmationToken,
          idempotencyKey: body.idempotencyKey,
          transaction,
        },
        async () => {
          await this.lockManagerChanges(current, transaction, [userId]);
          const membership = await this.employeeMembership(current, userId, transaction);
          const user = await this.repository.findUserForUpdate(userId, transaction);
          if (!user) throw new NotFoundException("Nie znaleziono konta pracownika");
          const status = body.status as "active" | "disabled";
          membership.status = status;
          membership.updatedAt = new Date();
          await this.repository.saveMembership(membership, transaction);
          user.status = status;
          user.updatedAt = new Date();
          await this.repository.saveUserStatus(user, transaction);
          let revokedSessions = 0;
          if (status === "disabled") {
            revokedSessions = await this.repository.revokeSessions(
              current.tenantId,
              userId,
              current.userId,
              transaction,
            );
          }
          await this.audit.record(
            {
              tenantId: current.tenantId,
              actorUserId: current.userId,
              action: "user.updated",
              resourceType: "user",
              resourceId: userId,
              outcome: "succeeded",
              metadata: { status, revokedSessions },
            },
            transaction,
          );
          return { userId, status, revokedSessions };
        },
      ),
    );
  }

  async resetPassword(current: SessionPrincipal, userId: string, input: unknown) {
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator pracownika");
    const body = strictObject(input, ["temporaryPassword", "confirmationToken", "idempotencyKey"]);
    if (typeof body.temporaryPassword !== "string" || passwordPolicyFailure(body.temporaryPassword)) {
      throw new BadRequestException("Hasło tymczasowe nie spełnia wymagań");
    }
    const passwordHash = await hashPassword(body.temporaryPassword);
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor: current,
          action: "team.user.password",
          targetId: userId,
          payload: { temporaryPassword: body.temporaryPassword as string },
          token: body.confirmationToken,
          idempotencyKey: body.idempotencyKey,
          transaction,
        },
        async () => {
          await this.lockManagerChanges(current, transaction, [userId]);
          await this.employeeMembership(current, userId, transaction);
          const user = await this.repository.findUserForUpdate(userId, transaction);
          if (!user) throw new NotFoundException("Nie znaleziono konta pracownika");
          const { revokedSessions } = await applyPasswordChange({
            user,
            tenantId: current.tenantId,
            actorUserId: current.userId,
            passwordHash,
            mustChangePassword: true,
            reason: "manager_reset",
            transaction,
            audit: this.audit,
          });
          return { userId, mustChangePassword: true, revokedSessions };
        },
      ),
    );
  }

  async access(current: SessionPrincipal, userId: string) {
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator pracownika");
    const membership = await this.employeeMembership(current, userId);
    const [tool, grant] = await Promise.all([
      this.repository.findTool(toolId),
      this.repository.findGrant(current.tenantId, userId, toolId),
    ]);
    if (!tool) throw new NotFoundException("Nie znaleziono automatyzacji");
    return {
      userId,
      toolId,
      toolName: tool.displayName,
      membershipStatus: membership.status,
      canExecute: Boolean(grant?.canExecute),
      version: grant?.version ?? 0,
      resultsShared: membership.status === "active",
      canDownloadResults: membership.status === "active",
    };
  }

  async setAccess(current: SessionPrincipal, userId: string, input: unknown) {
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator pracownika");
    const body = strictObject(input, ["canExecute", "expectedVersion", "confirmationToken", "idempotencyKey"]);
    if (
      typeof body.canExecute !== "boolean" ||
      !Number.isInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 0
    ) {
      throw new BadRequestException("Nieprawidłowe uprawnienie automatyzacji");
    }
    return this.repository.transaction(async (transaction) =>
      runConfirmedPrivilegedAction(
        {
          actor: current,
          action: "team.user.access",
          targetId: userId,
          payload: { canExecute: body.canExecute, expectedVersion: Number(body.expectedVersion) },
          token: body.confirmationToken,
          idempotencyKey: body.idempotencyKey,
          transaction,
        },
        async () => {
          await this.lockManagerChanges(current, transaction, [userId]);
          const membership = await this.employeeMembership(current, userId, transaction);
          if (membership.status !== "active") throw new ConflictException("Najpierw aktywuj konto pracownika");
          if (!(await this.repository.findTool(toolId, transaction)))
            throw new NotFoundException("Nie znaleziono automatyzacji");
          const grant = await this.repository.findGrant(current.tenantId, userId, toolId, transaction, true);
          const expectedVersion = Number(body.expectedVersion);
          if ((grant?.version ?? 0) !== expectedVersion)
            throw new ConflictException("Dostępy zmieniły się w innej sesji. Odśwież widok.");
          const now = new Date();
          const next =
            grant ??
            this.repository.buildGrant({
              tenantId: current.tenantId,
              userId,
              toolId,
              grantedBy: current.userId,
              createdAt: now,
              version: 0,
              canViewResults: false,
              canDownloadResults: false,
            });
          next.canDiscover = Boolean(body.canExecute);
          next.canExecute = Boolean(body.canExecute);
          next.grantedBy = current.userId;
          next.updatedAt = now;
          next.version = expectedVersion + 1;
          await this.repository.saveGrant(next, transaction);
          await this.audit.record(
            {
              tenantId: current.tenantId,
              actorUserId: current.userId,
              action: grant ? "tool.grant.updated" : "tool.grant.created",
              resourceType: "tool",
              resourceId: toolId,
              outcome: "succeeded",
              metadata: { userId, afterCanExecute: next.canExecute, version: next.version },
            },
            transaction,
          );
          return { userId, toolId, canExecute: next.canExecute, version: next.version };
        },
      ),
    );
  }
}
