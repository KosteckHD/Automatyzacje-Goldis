import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, ExecutionContext,
  ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Put, Query,
  Req, UseGuards,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import Redis from "ioredis";
import { Op, QueryTypes, type Transaction } from "sequelize";
import {
  ImportBatch, InterventionActivity, ManualIntervention,
  TenantMembership, Tool, ToolGrant, ToolSettings, User, UserSession, AutomationRun, RunDispatchOutbox, sequelize,
} from "./db";
import { hashPassword } from "./password-hash";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest, type SessionPrincipal } from "./session";
import { recordAuditEvent } from "./audit";
import { listToolAccess } from "./tool-access";
import { automationReadiness } from "./health-readiness";
import { canAssignIntervention } from "./authorization-policy";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roles = new Set(["admin", "operator", "reviewer", "auditor"]);
const toolIdPattern = /^[a-z0-9][a-z0-9-]{1,79}$/;
const maxPageSize = 100;

function requireCsrf(request: Request): void {
  if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
}

function principal(request: Request): SessionPrincipal {
  const actor = readSessionPrincipal(request);
  if (!actor) throw new ForbiddenException();
  return actor;
}

function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Nieprawidłowe dane żądania");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new BadRequestException("Nieznane pole żądania");
  return object;
}

function safePage(value: string | undefined, fallback = 50): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxPageSize) throw new BadRequestException("Nieprawidłowy limit strony");
  return parsed;
}

function parseIso(value: string | undefined, label: string): Date {
  if (!value || !Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    throw new BadRequestException(`Nieprawidłowy parametr ${label}; wymagany jest czas ISO ze strefą`);
  }
  return new Date(value);
}

function browserLabel(userAgent: string | undefined): string {
  const value = userAgent ?? "";
  const browser = /Edg\//.test(value) ? "Edge" : /Firefox\//.test(value) ? "Firefox" : /Chrome\//.test(value) ? "Chrome" : /Safari\//.test(value) ? "Safari" : "Przeglądarka";
  const os = /Windows/.test(value) ? "Windows" : /Mac OS/.test(value) ? "macOS" : /Android/.test(value) ? "Android" : /iPhone|iPad/.test(value) ? "iOS" : /Linux/.test(value) ? "Linux" : "inne";
  return `${browser} · ${os}`.slice(0, 80);
}

async function lockTenantAdminChanges(tenantId: string, transaction: Transaction) {
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended(:tenantId, 0))", {
    replacements: { tenantId }, transaction,
  });
}

async function unassignOpenInterventions(input: {
  tenantId: string; userId: string; actorUserId: string; toolId?: string; kind?: "sms" | "identity_review" | "portal_error";
  transaction: Transaction;
}): Promise<number> {
  const rows = await sequelize.query<{ interventionId: string }>(
    `SELECT mi.intervention_id AS "interventionId"
       FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
      WHERE b.tenant_id = :tenantId AND b.tool_id = COALESCE(:toolId, b.tool_id)
        AND mi.kind = COALESCE(:kind, mi.kind) AND mi.assignee_user_id = :userId AND mi.status = 'open'
      ORDER BY mi.intervention_id FOR UPDATE OF mi`,
    { replacements: { tenantId: input.tenantId, userId: input.userId, toolId: input.toolId ?? null, kind: input.kind ?? null }, type: QueryTypes.SELECT, transaction: input.transaction },
  );
  const now = new Date();
  for (const row of rows) {
    const intervention = await ManualIntervention.findByPk(row.interventionId, { transaction: input.transaction });
    if (!intervention || intervention.status !== "open" || intervention.assigneeUserId !== input.userId) continue;
    intervention.assigneeUserId = null;
    intervention.assignedAt = null;
    intervention.assignedBy = null;
    intervention.dueAt = null;
    intervention.revision += 1;
    intervention.updatedAt = now;
    await intervention.save({ transaction: input.transaction });
    await InterventionActivity.create({
      activityId: randomUUID(), interventionId: intervention.interventionId, actorUserId: input.actorUserId,
      eventType: "unassigned", previousAssigneeUserId: input.userId, nextAssigneeUserId: null, priority: null, createdAt: now,
    }, { transaction: input.transaction });
  }
  return rows.length;
}

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const actor = readSessionPrincipal(context.switchToHttp().getRequest<Request>());
    if (!actor) throw new ForbiddenException();
    if (actor.role !== "admin") throw new ForbiddenException("Funkcja dostępna dla administratora");
    return true;
  }
}

@Controller("tools")
@UseGuards(SessionGuard)
export class ToolCatalogController {
  @Get()
  async list(@Req() request: Request) {
    const actor = principal(request);
    const access = await listToolAccess(actor);
    if (!access.length) return { items: [] };
    const ids = access.map((item) => item.toolId);
    const tools = await Tool.findAll({ where: { toolId: ids }, order: [["sortOrder", "ASC"]] });
    return { items: tools.map((tool) => ({
      toolId: tool.toolId, displayName: tool.displayName, description: tool.description, status: tool.status,
      access: access.find((item) => item.toolId === tool.toolId),
    })) };
  }
}

@Controller("admin")
@UseGuards(SessionGuard, AdminOnlyGuard)
export class AdminController {
  @Get("overview")
  async overview(@Req() request: Request) {
    const actor = principal(request);
    const [users, tools, openInterventions, activeRuns] = await Promise.all([
      TenantMembership.count({ where: { tenantId: actor.tenantId, status: "active" } }),
      Tool.count(),
      sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
         JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND mi.status = 'open'`,
        { replacements: { tenantId: actor.tenantId }, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
         WHERE b.tenant_id = :tenantId AND r.status IN (:activeStatuses)`,
        { replacements: { tenantId: actor.tenantId, activeStatuses: ["queued", "validating", "pzu_login", "everest_search", "compensa_login", "compensa_form", "ufg_verification", "reading_oc", "export_ready", "waiting_for_sms", "waiting_for_manual_data", "identity_review"] }, type: QueryTypes.SELECT },
      ),
    ]);
    return { userCount: users, toolCount: tools, openInterventionCount: Number(openInterventions[0]?.count ?? 0), activeRunCount: Number(activeRuns[0]?.count ?? 0) };
  }

  @Get("users")
  async users(@Req() request: Request, @Query("limit") rawLimit?: string, @Query("cursor") cursor?: string, @Query("q") rawQuery?: string) {
    const actor = principal(request);
    const limit = safePage(rawLimit);
    const query = (rawQuery ?? "").trim().toLowerCase();
    if (query.length > 128 || /[\u0000-\u001f\u007f]/.test(query)) throw new BadRequestException("Nieprawidłowe wyszukiwanie użytkowników");
    const filterHash = createHash("sha256").update(query).digest("hex");
    let before: { createdAt: Date; userId: string } | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof decoded.createdAt !== "string" || !Number.isFinite(Date.parse(decoded.createdAt))
          || typeof decoded.userId !== "string" || !uuidPattern.test(decoded.userId)
          || (decoded.filterHash !== filterHash && !(query === "" && decoded.filterHash === undefined))) throw new Error();
        before = { createdAt: new Date(decoded.createdAt), userId: decoded.userId };
      } catch { throw new BadRequestException("Nieprawidłowy kursor użytkowników"); }
    }
    const rows = await sequelize.query<{
      userId: string; username: string; status: string; role: string; lastLoginAt: Date | null;
      createdAt: Date; activeSessionCount: number;
    }>(
      `SELECT u.user_id AS "userId", u.username, u.status, m.role,
              u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
              (SELECT count(*)::int FROM user_sessions s WHERE s.user_id = u.user_id
                AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS "activeSessionCount"
       FROM tenant_memberships m JOIN users u ON u.user_id = m.user_id
       WHERE m.tenant_id = :tenantId AND (:query = '' OR position(:query in u.username_normalized) > 0)
         AND (:beforeCreated IS NULL OR (u.created_at, u.user_id) < (:beforeCreated, :beforeId))
       ORDER BY u.created_at DESC, u.user_id DESC LIMIT :fetchLimit`,
      { replacements: { tenantId: actor.tenantId, query, beforeCreated: before?.createdAt ?? null, beforeId: before?.userId ?? null, fetchLimit: limit + 1 }, type: QueryTypes.SELECT },
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), userId: last.userId, filterHash })).toString("base64url") : null,
    };
  }

  @Post("users")
  async createUser(@Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["username", "password", "role"]);
    if (typeof body.username !== "string" || typeof body.password !== "string" || typeof body.role !== "string"
      || !roles.has(body.role)) throw new BadRequestException("Nieprawidłowe dane nowego użytkownika");
    const username = body.username.trim();
    if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)
      || body.password.length < 14 || body.password.length > 1024) {
      throw new BadRequestException("Login lub hasło nie spełnia wymagań");
    }
    const usernameNormalized = username.toLowerCase();
    const passwordHash = await hashPassword(body.password);
    try {
      const created = await sequelize.transaction(async (transaction) => {
        const now = new Date();
        const user = await User.create({
          userId: randomUUID(), username, usernameNormalized, passwordHash,
          status: "active", createdAt: now, updatedAt: now, lastLoginAt: null, mustChangePassword: true,
        }, { transaction });
        await TenantMembership.create({
          tenantId: actor.tenantId, userId: user.userId, role: body.role as "admin" | "operator" | "reviewer" | "auditor",
          status: "active", createdAt: now, updatedAt: now,
        }, { transaction });
        await recordAuditEvent({
          tenantId: actor.tenantId, actorUserId: actor.userId, action: "user.created",
          resourceType: "user", resourceId: user.userId, outcome: "succeeded", metadata: { role: String(body.role) },
        }, transaction);
        return { userId: user.userId, username: user.username, role: body.role, status: user.status, mustChangePassword: true };
      });
      return created;
    } catch (error) {
      if ((error as { name?: string }).name === "SequelizeUniqueConstraintError") throw new ConflictException("Login jest już zajęty");
      throw error;
    }
  }

  @Get("tools")
  async adminTools(@Req() request: Request) {
    principal(request);
    const tools = await Tool.findAll({ order: [["sortOrder", "ASC"], ["toolId", "ASC"]] });
    return { items: tools.map((tool) => ({
      toolId: tool.toolId, displayName: tool.displayName, description: tool.description, status: tool.status,
    })) };
  }

  @Get("users/:userId/grants")
  async grants(@Param("userId") userId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId } });
    if (!member) throw new NotFoundException();
    const tools = await sequelize.query<{
      toolId: string; displayName: string; status: string; canDiscover: boolean | null; canExecute: boolean | null;
      canViewResults: boolean | null; canDownloadResults: boolean | null; version: number | null;
    }>(
      `SELECT t.tool_id AS "toolId", t.display_name AS "displayName", t.status,
              g.can_discover AS "canDiscover", g.can_execute AS "canExecute",
              g.can_view_results AS "canViewResults", g.can_download_results AS "canDownloadResults", g.version
       FROM tools t LEFT JOIN tool_grants g ON g.tool_id = t.tool_id AND g.tenant_id = :tenantId AND g.user_id = :userId
       ORDER BY t.sort_order, t.tool_id`,
      { replacements: { tenantId: actor.tenantId, userId }, type: QueryTypes.SELECT },
    );
    return { userId, role: member.role, items: tools.map((tool) => ({
      ...tool, canDiscover: Boolean(tool.canDiscover), canExecute: Boolean(tool.canExecute),
      canViewResults: Boolean(tool.canViewResults), canDownloadResults: Boolean(tool.canDownloadResults), version: tool.version ?? 0,
    })) };
  }

  @Put("users/:userId/grants/:toolId")
  async setGrant(@Param("userId") userId: string, @Param("toolId") toolId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId) || !toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowy użytkownik lub narzędzie");
    const body = strictObject(input, ["canDiscover", "canExecute", "canViewResults", "canDownloadResults", "expectedVersion"]);
    const bools = ["canDiscover", "canExecute", "canViewResults", "canDownloadResults"] as const;
    if (bools.some((key) => typeof body[key] !== "boolean") || !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
      throw new BadRequestException("Nieprawidłowy zestaw uprawnień");
    }
    const requested = {
      canDiscover: Boolean(body.canDiscover || body.canExecute),
      canExecute: Boolean(body.canExecute),
      canViewResults: Boolean(body.canViewResults || body.canDownloadResults),
      canDownloadResults: Boolean(body.canDownloadResults),
    };
    const result = await sequelize.transaction(async (transaction) => {
      const membership = await TenantMembership.findOne({
        where: { tenantId: actor.tenantId, userId, status: "active" }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!membership || !await Tool.findByPk(toolId, { transaction })) throw new NotFoundException();
      const existing = await ToolGrant.findOne({
        where: { tenantId: actor.tenantId, userId, toolId }, transaction, lock: transaction.LOCK.UPDATE,
      });
      const expectedVersion = Number(body.expectedVersion);
      if ((existing?.version ?? 0) !== expectedVersion) throw new ConflictException("Uprawnienia zmieniły się w innej sesji");
      const now = new Date();
      const grant = existing ?? ToolGrant.build({
        tenantId: actor.tenantId, userId, toolId, grantedBy: actor.userId, createdAt: now, version: 0,
      });
      Object.assign(grant, requested, { grantedBy: actor.userId, updatedAt: now, version: expectedVersion + 1 });
      await grant.save({ transaction });
      const lostView = Boolean(existing?.canViewResults && !requested.canViewResults);
      const lostExecute = Boolean(existing?.canExecute && !requested.canExecute);
      const unassignedInterventions = lostView || lostExecute
        ? await unassignOpenInterventions({
          tenantId: actor.tenantId, userId, actorUserId: actor.userId, toolId,
          ...(lostView ? {} : { kind: "sms" as const }), transaction,
        })
        : 0;
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId,
        action: existing ? "tool.grant.updated" : "tool.grant.created", resourceType: "tool", resourceId: toolId,
        outcome: "succeeded", metadata: { userId, ...requested, version: grant.version, unassignedInterventions },
      }, transaction);
      return { userId, toolId, ...requested, version: grant.version, unassignedInterventions };
    });
    return result;
  }

  @Post("users/:userId/grants/:toolId/revoke")
  async revokeGrant(@Param("userId") userId: string, @Param("toolId") toolId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId) || !toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowy użytkownik lub narzędzie");
    const body = strictObject(input, ["expectedVersion"]);
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new BadRequestException("Nieprawidłowa wersja grantu");
    return sequelize.transaction(async (transaction) => {
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!member || !await Tool.findByPk(toolId, { transaction })) throw new NotFoundException();
      const grant = await ToolGrant.findOne({ where: { tenantId: actor.tenantId, userId, toolId }, transaction, lock: transaction.LOCK.UPDATE });
      if ((grant?.version ?? 0) !== Number(body.expectedVersion)) throw new ConflictException("Uprawnienia zmieniły się w innej sesji");
      await ToolGrant.destroy({ where: { tenantId: actor.tenantId, userId, toolId }, transaction });
      const unassignedInterventions = await unassignOpenInterventions({ tenantId: actor.tenantId, userId, toolId, actorUserId: actor.userId, transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "tool.grant.revoked",
        resourceType: "tool", resourceId: toolId, outcome: "succeeded",
        metadata: { userId, existed: Boolean(grant), unassignedInterventions },
      }, transaction);
      return { userId, toolId, revoked: Boolean(grant), unassignedInterventions };
    });
  }

  @Get("tools/:toolId/settings")
  async getSettings(@Param("toolId") toolId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
    const tool = await Tool.findByPk(toolId, { attributes: ["toolId"] });
    const settings = await ToolSettings.findOne({ where: { tenantId: actor.tenantId, toolId } });
    if (!tool || !settings) throw new NotFoundException();
    return {
      toolId, enabledForNewRuns: settings.enabledForNewRuns, maxNewRunsPerHour: settings.maxNewRunsPerHour,
      allowedLocalStart: settings.allowedLocalStart, allowedLocalEnd: settings.allowedLocalEnd,
      timezone: settings.timezone, version: settings.version, updatedAt: settings.updatedAt,
    };
  }

  @Patch("tools/:toolId/settings")
  async updateSettings(@Param("toolId") toolId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
    const body = strictObject(input, ["enabledForNewRuns", "maxNewRunsPerHour", "allowedLocalStart", "allowedLocalEnd", "timezone", "expectedVersion"]);
    if (typeof body.enabledForNewRuns !== "boolean" || !Number.isInteger(body.expectedVersion)
      || Number(body.expectedVersion) < 1) throw new BadRequestException("Nieprawidłowa wersja lub stan ustawień");
    const limit = body.maxNewRunsPerHour;
    if (limit !== null && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10000)) {
      throw new BadRequestException("Limit musi być pusty albo liczbą od 1 do 10000");
    }
    const start = body.allowedLocalStart;
    const end = body.allowedLocalEnd;
    const validTime = (value: unknown) => value === null || (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
    if (!validTime(start) || !validTime(end) || ((start === null) !== (end === null))) {
      throw new BadRequestException("Podaj oba czasy okna pracy w formacie HH:mm albo wyczyść oba");
    }
    if (start !== null && end !== null && start === end) throw new BadRequestException("Godzina końca musi być różna od godziny początku");
    const timezone = body.timezone;
    if (typeof timezone !== "string" || timezone.length > 80) throw new BadRequestException("Nieprawidłowa strefa czasowa");
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
    catch { throw new BadRequestException("Nieznana strefa czasowa"); }
    return sequelize.transaction(async (transaction) => {
      const tool = await Tool.findByPk(toolId, { transaction });
      const settings = await ToolSettings.findOne({ where: { tenantId: actor.tenantId, toolId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!tool || !settings) throw new NotFoundException();
      if (settings.version !== Number(body.expectedVersion)) throw new ConflictException("Ustawienia zmieniły się w innej sesji");
      const oldEnabled = settings.enabledForNewRuns;
      Object.assign(settings, {
        enabledForNewRuns: body.enabledForNewRuns,
        maxNewRunsPerHour: limit,
        allowedLocalStart: start,
        allowedLocalEnd: end,
        timezone,
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: settings.version + 1,
      });
      await settings.save({ transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "settings.updated",
        resourceType: "settings", resourceId: toolId, outcome: "succeeded",
        metadata: { version: settings.version, enabledForNewRuns: settings.enabledForNewRuns, wasEnabled: oldEnabled },
      }, transaction);
      return {
        toolId, enabledForNewRuns: settings.enabledForNewRuns, maxNewRunsPerHour: settings.maxNewRunsPerHour,
        allowedLocalStart: settings.allowedLocalStart, allowedLocalEnd: settings.allowedLocalEnd,
        timezone: settings.timezone, version: settings.version, updatedAt: settings.updatedAt,
      };
    });
  }

  @Get("operations/summary")
  async operationsSummary(@Req() request: Request) {
    const actor = principal(request);
    const counts = await sequelize.query<{ status: string; count: number }>(
      `SELECT r.status, count(*)::int AS count FROM automation_runs r
       JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId
       GROUP BY r.status ORDER BY r.status`,
      { replacements: { tenantId: actor.tenantId }, type: QueryTypes.SELECT },
    );
    const dispatch = await sequelize.query<{ pendingCount: number; oldestCreatedAt: Date | null }>(
      `SELECT count(*) FILTER (WHERE d.status IN ('pending', 'publishing', 'published'))::int AS "pendingCount",
              min(d.created_at) FILTER (WHERE d.status IN ('pending', 'publishing', 'published')) AS "oldestCreatedAt"
       FROM run_dispatch_outbox d JOIN automation_runs r ON r.id = d.run_id
       JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId`,
      { replacements: { tenantId: actor.tenantId }, type: QueryTypes.SELECT },
    );
    const openInterventionCount = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM manual_interventions mi
       JOIN automation_runs r ON r.id = mi.run_id JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND mi.status = 'open'`,
      { replacements: { tenantId: actor.tenantId }, type: QueryTypes.SELECT },
    );
    let redisReady = false;
    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: () => null,
      });
      redis.on("error", () => undefined);
      try { await redis.connect(); redisReady = (await redis.ping()) === "PONG"; }
      catch { redisReady = false; }
      finally { await redis.quit().catch(() => redis.disconnect()); }
    }
    const runtime = await sequelize.query<{ mode: "off" | "live"; portalConfigValid: boolean; observedAt: Date }>(
      `SELECT mode, portal_config_valid AS "portalConfigValid", observed_at AS "observedAt"
       FROM worker_runtime_status WHERE worker_id = 'portal-worker' LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    const readiness = automationReadiness({ servicesReady: redisReady, worker: runtime[0] ?? null });
    return {
      observedAt: new Date().toISOString(), api: "online", database: "online", redis: redisReady ? "online" : "offline",
      worker: readiness.worker, portalMode: readiness.portalMode, portalConfig: readiness.portalConfig,
      automationReady: readiness.automationReady, runCounts: Object.fromEntries(counts.map((item) => [item.status, Number(item.count)])),
      openInterventionCount: Number(openInterventionCount[0]?.count ?? 0),
      dispatch: { pendingCount: Number(dispatch[0]?.pendingCount ?? 0), oldestCreatedAt: dispatch[0]?.oldestCreatedAt ?? null },
    };
  }

  @Get("operations/runs")
  async operationsRuns(@Req() request: Request, @Query("toolId") toolId?: string, @Query("status") status?: string, @Query("page") rawPage?: string) {
    const actor = principal(request);
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new BadRequestException("Nieprawidłowa strona");
    if (toolId && !toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
    if (status && !/^[a-z_]{2,40}$/.test(status)) throw new BadRequestException("Nieprawidłowy status");
    const rows = await sequelize.query(
      `SELECT r.id, r.tool_id AS "toolId", r.status, r.current_step AS "currentStep", r.row_number AS "rowNumber",
              r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.started_at AS "startedAt", r.finished_at AS "finishedAt",
              r.error_code AS "errorCode", b.id AS "batchId"
       FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND (:toolId IS NULL OR b.tool_id = :toolId)
         AND (:status IS NULL OR r.status = :status)
       ORDER BY r.created_at DESC, r.id DESC LIMIT :limit OFFSET :offset`,
      { replacements: { tenantId: actor.tenantId, toolId: toolId ?? null, status: status ?? null, limit: 51, offset: (page - 1) * 50 }, type: QueryTypes.SELECT },
    );
    return { page, hasMore: rows.length > 50, items: rows.slice(0, 50) };
  }

  @Get("interventions")
  async adminInterventions(@Req() request: Request, @Query("status") status = "open", @Query("assigneeUserId") assigneeUserId?: string,
    @Query("toolId") toolId?: string, @Query("priority") priority?: string, @Query("page") rawPage?: string) {
    const actor = principal(request);
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!new Set(["open", "resolved", "cancelled", "expired", "all"]).has(status)
      || !Number.isInteger(page) || page < 1 || page > 100000
      || (assigneeUserId && !uuidPattern.test(assigneeUserId))
      || (toolId && !toolIdPattern.test(toolId))
      || (priority && !new Set(["normal", "high"]).has(priority))) {
      throw new BadRequestException("Nieprawidłowy filtr interwencji");
    }
    const rows = await sequelize.query(
      `SELECT mi.intervention_id AS "interventionId", mi.run_id AS "runId", b.tool_id AS "toolId",
              mi.kind, mi.portal, mi.reason_code AS "reasonCode", mi.status, mi.priority, mi.due_at AS "dueAt",
              mi.assignee_user_id AS "assigneeUserId", assignee.username AS "assigneeUsername",
              mi.revision, mi.created_at AS "createdAt", mi.updated_at AS "updatedAt",
              r.row_number AS "rowNumber", r.current_step AS "currentStep", r.error_code AS "runErrorCode"
       FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
       LEFT JOIN users assignee ON assignee.user_id = mi.assignee_user_id
       WHERE b.tenant_id = :tenantId AND (:status = 'all' OR mi.status = :status)
         AND (:assignee IS NULL OR mi.assignee_user_id = :assignee)
         AND (:toolId IS NULL OR b.tool_id = :toolId)
         AND (:priority IS NULL OR mi.priority = :priority)
       ORDER BY CASE WHEN mi.priority = 'high' THEN 0 ELSE 1 END, mi.created_at ASC, mi.intervention_id ASC
        LIMIT 51 OFFSET :offset`,
      { replacements: { tenantId: actor.tenantId, status, assignee: assigneeUserId ?? null, toolId: toolId ?? null, priority: priority ?? null, offset: (page - 1) * 50 }, type: QueryTypes.SELECT },
    );
    return { page, hasMore: rows.length > 50, items: rows.slice(0, 50) };
  }

  @Patch("interventions/:id/assignment")
  async assignIntervention(@Param("id") interventionId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["assigneeUserId", "dueAt", "expectedRevision"]);
    if (!uuidPattern.test(interventionId)
      || (body.assigneeUserId !== null && (typeof body.assigneeUserId !== "string" || !uuidPattern.test(body.assigneeUserId)))
      || !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      throw new BadRequestException("Nieprawidłowe przypisanie");
    }
    let dueAt: Date | null = null;
    if (body.dueAt !== undefined && body.dueAt !== null) {
      if (typeof body.dueAt !== "string") throw new BadRequestException("Nieprawidłowy termin");
      dueAt = parseIso(body.dueAt, "dueAt");
    }
    return sequelize.transaction(async (transaction) => {
      const intervention = await ManualIntervention.findByPk(interventionId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!intervention || intervention.status !== "open") throw new NotFoundException();
      if (intervention.revision !== Number(body.expectedRevision)) throw new ConflictException("Zgłoszenie zmieniło się w innej sesji");
      const run = await AutomationRun.findByPk(intervention.runId, { transaction });
      const batch = run ? await ImportBatch.findByPk(run.batchId, { transaction }) : null;
      if (!run || !batch || batch.tenantId !== actor.tenantId || batch.toolId !== run.toolId) throw new NotFoundException();
      const nextAssignee = body.assigneeUserId as string | null;
      if (nextAssignee) {
        const member = await TenantMembership.findOne({
          where: { tenantId: actor.tenantId, userId: nextAssignee, status: "active" },
          include: [{ model: User, required: true, where: { status: "active" }, attributes: ["userId"] }],
          transaction,
        });
        if (!member) throw new BadRequestException("Odbiorca nie jest aktywnym użytkownikiem tej organizacji");
        if (member.role !== "admin") {
          const grant = await ToolGrant.findOne({ where: { tenantId: actor.tenantId, toolId: batch.toolId, userId: nextAssignee }, transaction });
          const canAssign = canAssignIntervention({
            role: member.role, kind: intervention.kind as "sms" | "identity_review" | "portal_error",
            canViewResults: Boolean(grant?.canViewResults || grant?.canDownloadResults),
            canExecute: Boolean(grant?.canExecute),
          });
          if (!canAssign) throw new BadRequestException("Odbiorca nie ma roli ani dostępu do tego rodzaju zgłoszenia");
        }
      }
      const now = new Date();
      const oldAssignee = intervention.assigneeUserId;
      const changed = oldAssignee !== nextAssignee || intervention.dueAt?.getTime() !== dueAt?.getTime();
      if (!changed) return { interventionId, assigneeUserId: oldAssignee, dueAt: intervention.dueAt, revision: intervention.revision };
      intervention.assigneeUserId = nextAssignee;
      intervention.assignedAt = nextAssignee ? now : null;
      intervention.assignedBy = nextAssignee ? actor.userId : null;
      intervention.dueAt = dueAt;
      intervention.updatedAt = now;
      intervention.revision += 1;
      await intervention.save({ transaction });
      const eventType = nextAssignee ? "assigned" : "unassigned";
      await InterventionActivity.create({
        activityId: randomUUID(), interventionId, actorUserId: actor.userId, eventType,
        previousAssigneeUserId: oldAssignee, nextAssigneeUserId: nextAssignee, priority: null, createdAt: now,
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId,
        action: nextAssignee ? "intervention.assigned" : "intervention.unassigned",
        resourceType: "intervention", resourceId: interventionId, outcome: "succeeded",
        metadata: { previousAssigneeUserId: oldAssignee, assigneeUserId: nextAssignee, revision: intervention.revision },
      }, transaction);
      return { interventionId, assigneeUserId: nextAssignee, dueAt, revision: intervention.revision };
    });
  }

  @Patch("interventions/:id/priority")
  async setInterventionPriority(@Param("id") interventionId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["priority", "expectedRevision"]);
    if (!uuidPattern.test(interventionId) || !new Set(["normal", "high"]).has(String(body.priority))
      || !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      throw new BadRequestException("Nieprawidłowy priorytet");
    }
    return sequelize.transaction(async (transaction) => {
      const intervention = await ManualIntervention.findByPk(interventionId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!intervention || intervention.status !== "open") throw new NotFoundException();
      if (intervention.revision !== Number(body.expectedRevision)) throw new ConflictException("Zgłoszenie zmieniło się w innej sesji");
      const run = await AutomationRun.findByPk(intervention.runId, { transaction });
      const batch = run ? await ImportBatch.findByPk(run.batchId, { transaction }) : null;
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException();
      const priority = body.priority as "normal" | "high";
      if (intervention.priority === priority) return { interventionId, priority, revision: intervention.revision };
      const now = new Date();
      intervention.priority = priority; intervention.revision += 1; intervention.updatedAt = now;
      await intervention.save({ transaction });
      await InterventionActivity.create({
        activityId: randomUUID(), interventionId, actorUserId: actor.userId, eventType: "priority_changed",
        previousAssigneeUserId: null, nextAssigneeUserId: null, priority, createdAt: now,
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "intervention.priority_changed",
        resourceType: "intervention", resourceId: interventionId, outcome: "succeeded",
        metadata: { priority, revision: intervention.revision },
      }, transaction);
      return { interventionId, priority, revision: intervention.revision };
    });
  }

  @Get("interventions/:id/activity")
  async interventionActivity(@Param("id") interventionId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!uuidPattern.test(interventionId)) throw new BadRequestException("Nieprawidłowe zgłoszenie");
    const scoped = await sequelize.query<{ visible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM manual_interventions mi
         JOIN automation_runs r ON r.id = mi.run_id
         JOIN import_batches b ON b.id = r.batch_id
         WHERE mi.intervention_id = :interventionId AND b.tenant_id = :tenantId
       ) AS visible`,
      { replacements: { interventionId, tenantId: actor.tenantId }, type: QueryTypes.SELECT },
    );
    if (!scoped[0]?.visible) throw new NotFoundException();
    const rows = await sequelize.query(
      `SELECT ia.activity_id AS "activityId", ia.event_type AS "eventType",
              ia.previous_assignee_user_id AS "previousAssigneeUserId",
              previous.username AS "previousAssigneeUsername",
              ia.next_assignee_user_id AS "nextAssigneeUserId", next_user.username AS "nextAssigneeUsername",
              ia.priority, ia.created_at AS "createdAt", actor.username AS "actorUsername"
       FROM intervention_activity ia JOIN users actor ON actor.user_id = ia.actor_user_id
       LEFT JOIN users previous ON previous.user_id = ia.previous_assignee_user_id
       LEFT JOIN users next_user ON next_user.user_id = ia.next_assignee_user_id
       JOIN manual_interventions mi ON mi.intervention_id = ia.intervention_id
       JOIN automation_runs r ON r.id = mi.run_id JOIN import_batches b ON b.id = r.batch_id
       WHERE ia.intervention_id = :interventionId AND b.tenant_id = :tenantId
       ORDER BY ia.created_at DESC, ia.activity_id DESC LIMIT 100`,
      { replacements: { interventionId, tenantId: actor.tenantId }, type: QueryTypes.SELECT },
    );
    return { items: rows };
  }

  @Get("users/:userId/sessions")
  async userSessions(@Param("userId") userId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, attributes: ["userId"] });
    if (!member) throw new NotFoundException();
    const sessions = await UserSession.findAll({
      where: { tenantId: actor.tenantId, userId }, attributes: ["sessionId", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "browserLabel"],
      order: [["createdAt", "DESC"]], limit: 100,
    });
    const current = principal(request);
    return { items: sessions.map((session) => ({ ...session.toJSON(), isCurrent: session.sessionId === current.sessionId })) };
  }

  @Post("users/:userId/sessions/:sessionId/revoke")
  async revokeUserSession(@Param("userId") userId: string, @Param("sessionId") sessionId: string, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId) || !uuidPattern.test(sessionId)) throw new BadRequestException("Nieprawidłowa sesja");
    return sequelize.transaction(async (transaction) => {
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction });
      if (!member) throw new NotFoundException();
      const now = new Date();
      const [count] = await UserSession.update({ revokedAt: now, revokedBy: actor.userId, revokeReason: "admin" }, {
        where: { tenantId: actor.tenantId, userId, sessionId, revokedAt: null }, transaction,
      });
      if (!count) throw new NotFoundException("Aktywna sesja nie istnieje");
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "session", resourceId: sessionId, outcome: "succeeded", metadata: { revokedByAdmin: true },
      }, transaction);
      return { sessionId, revoked: true, currentSession: sessionId === actor.sessionId };
    });
  }

  @Post("users/:userId/revoke-sessions")
  async revokeUserSessions(@Param("userId") userId: string, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    return sequelize.transaction(async (transaction) => {
      await lockTenantAdminChanges(actor.tenantId, transaction);
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!member) throw new NotFoundException();
      const now = new Date();
      const [count] = await UserSession.update({ revokedAt: now, revokedBy: actor.userId, revokeReason: "admin" }, {
        where: { tenantId: actor.tenantId, userId, revokedAt: null, expiresAt: { [Op.gt]: now } }, transaction,
      });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { count },
      }, transaction);
      return { revokedCount: count };
    });
  }

  @Post("users/:userId/disable")
  async disableUser(@Param("userId") userId: string, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    return sequelize.transaction(async (transaction) => {
      await lockTenantAdminChanges(actor.tenantId, transaction);
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!member) throw new NotFoundException();
      if (member.role === "admin" && member.status === "active") {
        const otherAdmins = await TenantMembership.count({ where: { tenantId: actor.tenantId, role: "admin", status: "active", userId: { [Op.ne]: userId } }, transaction });
        if (otherAdmins < 1) throw new ConflictException("Organizacja musi mieć co najmniej jednego aktywnego administratora");
      }
      const now = new Date();
      member.status = "disabled";
      member.updatedAt = now;
      await member.save({ transaction });
      const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (user) { user.status = "disabled"; user.updatedAt = now; await user.save({ transaction, fields: ["status", "updatedAt"] }); }
      const [revokedSessions] = await UserSession.update({ revokedAt: now, revokedBy: actor.userId, revokeReason: "account_change" }, {
        where: { tenantId: actor.tenantId, userId, revokedAt: null }, transaction,
      });
      if (revokedSessions) await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { count: revokedSessions, reason: "account_change" },
      }, transaction);
      const unassignedInterventions = await unassignOpenInterventions({ tenantId: actor.tenantId, userId, actorUserId: actor.userId, transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "user.updated",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { status: "disabled", unassignedInterventions },
      }, transaction);
      return { userId, status: "disabled" };
    });
  }

  @Post("users/:userId/enable")
  async enableUser(@Param("userId") userId: string, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    return sequelize.transaction(async (transaction) => {
      await lockTenantAdminChanges(actor.tenantId, transaction);
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction, lock: transaction.LOCK.UPDATE });
      const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!member || !user) throw new NotFoundException();
      member.status = "active"; member.updatedAt = new Date(); await member.save({ transaction });
      user.status = "active"; user.updatedAt = new Date(); await user.save({ transaction, fields: ["status", "updatedAt"] });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "user.updated",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { status: "active" },
      }, transaction);
      return { userId, status: "active" };
    });
  }

  @Patch("users/:userId/role")
  async updateRole(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["role"]);
    if (!uuidPattern.test(userId) || typeof body.role !== "string" || !roles.has(body.role)) throw new BadRequestException("Nieprawidłowy identyfikator lub rola");
    return sequelize.transaction(async (transaction) => {
      await lockTenantAdminChanges(actor.tenantId, transaction);
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!member) throw new NotFoundException();
      if (member.role === "admin" && body.role !== "admin" && member.status === "active") {
        const otherAdmins = await TenantMembership.count({ where: { tenantId: actor.tenantId, role: "admin", status: "active", userId: { [Op.ne]: userId } }, transaction });
        if (otherAdmins < 1) throw new ConflictException("Organizacja musi mieć co najmniej jednego aktywnego administratora");
      }
      const oldRole = member.role;
      member.role = body.role as typeof member.role; member.updatedAt = new Date(); await member.save({ transaction });
      const [revokedSessions] = await UserSession.update({ revokedAt: new Date(), revokedBy: actor.userId, revokeReason: "account_change" }, {
        where: { tenantId: actor.tenantId, userId, revokedAt: null }, transaction,
      });
      if (revokedSessions) await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { count: revokedSessions, reason: "role_change" },
      }, transaction);
      const unassignedInterventions = oldRole !== body.role && body.role !== "admin"
        ? await unassignOpenInterventions({ tenantId: actor.tenantId, userId, actorUserId: actor.userId, transaction })
        : 0;
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "user.updated",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { oldRole, role: String(body.role), unassignedInterventions },
      }, transaction);
      return { userId, role: member.role, unassignedInterventions };
    });
  }

  @Post("users/:userId/password")
  async resetPassword(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["temporaryPassword"]);
    if (!uuidPattern.test(userId) || typeof body.temporaryPassword !== "string"
      || body.temporaryPassword.length < 14 || body.temporaryPassword.length > 1024) {
      throw new BadRequestException("Hasło tymczasowe nie spełnia wymagań");
    }
    const passwordHash = await hashPassword(body.temporaryPassword);
    return sequelize.transaction(async (transaction) => {
      const member = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId }, transaction });
      const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!member || !user) throw new NotFoundException();
      user.passwordHash = passwordHash; user.mustChangePassword = true; user.updatedAt = new Date();
      await user.save({ transaction, fields: ["passwordHash", "mustChangePassword", "updatedAt"] });
      const [revokedSessions] = await UserSession.update({ revokedAt: new Date(), revokedBy: actor.userId, revokeReason: "password_change" }, {
        where: { tenantId: actor.tenantId, userId, revokedAt: null }, transaction,
      });
      if (revokedSessions) await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { count: revokedSessions, reason: "password_change" },
      }, transaction);
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "user.updated",
        resourceType: "user", resourceId: userId, outcome: "succeeded", metadata: { credentialReset: true },
      }, transaction);
      return { userId, mustChangePassword: true };
    });
  }
}
