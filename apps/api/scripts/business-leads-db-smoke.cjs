"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const models = require("../dist/infrastructure/database/db");
const { hashPassword } = require("../dist/features/auth/index");

async function createAccount(tenantId, role, suffix, now) {
  const userId = randomUUID();
  const username = `Synthetic.Lead.${suffix}.${randomUUID().slice(0, 6)}`;
  const password = `Synthetic-only ${suffix} password!`;
  await models.User.create({ userId, username, usernameNormalized: username.toLowerCase(),
    passwordHash: await hashPassword(password), status: "active", credentialRevision: 1,
    mustChangePassword: false, createdAt: now, updatedAt: now, lastLoginAt: null });
  await models.TenantMembership.create({ tenantId, userId, role, status: "active", createdAt: now, updatedAt: now });
  return { userId, username, password };
}

module.exports = async function verifyBusinessLeadFlows(seed) {
  let smokeStage = "service_setup";
  const previousBindingKey = process.env.PRIVILEGED_ACTION_BINDING_KEY;
  process.env.PRIVILEGED_ACTION_BINDING_KEY = "synthetic-business-leads-binding-key-32-bytes-minimum";
  try {
  const { BusinessLeadService } = require("../dist/features/leads/business-leads.service");
  const { ContactReportService } = require("../dist/features/reports/contact-report.service");
  const { DashboardService } = require("../dist/features/reports/dashboard.service");
  const { NotificationService } = require("../dist/features/notifications/notifications.service");
  const { NotificationsRepository } = require("../dist/features/notifications/notifications.repository");
  const { TeamService } = require("../dist/features/teams/index");
  const { TeamRepository } = require("../dist/features/teams/team.repository");
  const { recordAuditEvent } = require("../dist/features/audit/public");
  const { ConflictException, ForbiddenException, NotFoundException } = require("@nestjs/common");
  const tenantId = seed.goldisTenantId;
  const now = new Date();
  const manager = await createAccount(tenantId, "manager", "Manager", now);
  const employee = await createAccount(tenantId, "operator", "Employee", now);
  const sessionId = randomUUID();
  await models.UserSession.create({ sessionId, tenantId, userId: manager.userId, credentialRevision: 1,
    createdAt: now, lastSeenAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 3_600_000),
    revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic lead smoke" });
  const actor = { userId: manager.userId, tenantId, actorRef: manager.userId, role: "manager", sessionId,
    exp: Date.now() + 3_600_000, csrf: "synthetic-leads-csrf-token-0123456789", version: 2 };
  const notifications = new NotificationService(new NotificationsRepository());
  const leadService = new BusinessLeadService(notifications);
  const team = new TeamService({ record: recordAuditEvent }, new TeamRepository(models.sequelize));
  const employeeActor = { userId: employee.userId, tenantId, actorRef: employee.userId, role: "operator",
    exp: Date.now() + 3_600_000, csrf: "synthetic-employee-csrf-token-0123456789", version: 2 };

  smokeStage = "team_create_access";
  const createPayload = { username: `Synthetic.New.${randomUUID().slice(0, 8)}`,
    temporaryPassword: "Synthetic-only Employee Password!" };
  const createAction = "team.user.create";
  const createIdempotencyKey = randomUUID();
  const { PrivilegedActionService } = require("../dist/features/privileged-actions/privileged-actions.service");
  const confirmationService = new PrivilegedActionService({
    async consumeReauthAttempt() { return { allowed: true, retryAfterSeconds: 0 }; },
    async clearReauth() {},
    async recordReauthFailure() {},
  }, { record: recordAuditEvent });
  const confirmAction = (action, targetId, payload, idempotencyKey) => confirmationService.create(actor,
    { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
    { action, targetId, payload, currentPassword: manager.password, idempotencyKey }, { setHeader() {} });
  const createConfirmation = await confirmAction(createAction, null, createPayload, createIdempotencyKey);
  const created = await team.create(actor, { ...createPayload, confirmationToken: createConfirmation.token,
    idempotencyKey: createIdempotencyKey });
  assert.equal(created.role, "operator", "manager-created account must always be an employee");
  const accessBefore = await team.access(actor, employee.userId);
  assert.equal(accessBefore.resultsShared, true);
  assert.equal(accessBefore.canExecute, false);
  const accessPayload = { canExecute: true, expectedVersion: 0 };
  const accessIdempotencyKey = randomUUID();
  const accessConfirmation = await confirmAction("team.user.access", employee.userId, accessPayload, accessIdempotencyKey);
  const accessAfter = await team.setAccess(actor, employee.userId, { ...accessPayload,
    confirmationToken: accessConfirmation.token, idempotencyKey: accessIdempotencyKey });
  assert.equal(accessAfter.canExecute, true);

  smokeStage = "seed_result_set_and_leads";
  const resultSetId = randomUUID();
  const sourceId = randomUUID();
  await models.ResultSet.create({ resultSetId, tenantId, batchId: seed.goldis.batchId, toolId: "oc-policy-verification",
    actorUserId: manager.userId, sourceType: "prepared_set_execution", sourceId, referenceDate: "2026-10-11",
    status: "completed", createdAt: now, updatedAt: now, finishedAt: now });
  const entities = [];
  for (let index = 0; index < 3; index += 1) {
    const canonicalEntityId = randomUUID();
    await models.CanonicalEntity.create({ canonicalEntityId, tenantId, nipNormalized: `${String(index + 1).repeat(10)}`,
      regon: `${String(index + 1).repeat(9)}`, businessName: `Synthetic Lead Company ${index + 1}`, createdAt: now, updatedAt: now });
    entities.push(canonicalEntityId);
  }
  const leads = [];
  for (const [index, canonicalEntityId] of entities.entries()) {
    leads.push(await models.BusinessLead.create({ leadId: randomUUID(), resultSetId, tenantId,
      toolId: "oc-policy-verification", canonicalEntityId, sourceRowIds: [], companyName: `Synthetic Lead Company ${index + 1}`,
      nip: `${String(index + 1).repeat(10)}`, regon: `${String(index + 1).repeat(9)}`, address: "Test 1",
      postalCode: "00-001", city: "Warszawa", decisionMakerNames: [], contactData: [], resultStatus: "ready",
      contactStatus: "not_contacted", assignedToUserId: null, assignedByUserId: null, assignedAt: null,
      contactStatusVersion: 1, contactStatusUpdatedAt: null, createdAt: now, updatedAt: now }));
  }
  const otherResultSetId = randomUUID();
  await models.ResultSet.create({ resultSetId: otherResultSetId, tenantId, batchId: seed.goldis.batchId, toolId: "oc-policy-verification",
    actorUserId: manager.userId, sourceType: "prepared_set_execution", sourceId: randomUUID(), referenceDate: "2026-10-11",
    status: "completed", createdAt: now, updatedAt: now, finishedAt: now });
  const otherEntityId = randomUUID();
  const otherNip = randomUUID().replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
  const otherRegon = randomUUID().replace(/\D/g, "").padEnd(9, "0").slice(0, 9);
  await models.CanonicalEntity.create({ canonicalEntityId: otherEntityId, tenantId, nipNormalized: otherNip,
    regon: otherRegon, businessName: `Synthetic Lead Company ${otherNip}`, createdAt: now, updatedAt: now });
  const otherSetLead = await models.BusinessLead.create({ leadId: randomUUID(), resultSetId: otherResultSetId, tenantId,
    toolId: "oc-policy-verification", canonicalEntityId: otherEntityId, sourceRowIds: [], companyName: `Synthetic Lead Company ${otherNip}`,
    nip: otherNip, regon: otherRegon, address: "Test 2", postalCode: "00-001", city: "Warszawa", decisionMakerNames: [], contactData: [],
    resultStatus: "ready", contactStatus: "not_contacted", assignedToUserId: null, assignedByUserId: null, assignedAt: null,
    contactStatusVersion: 1, contactStatusUpdatedAt: null, createdAt: now, updatedAt: now });

  smokeStage = "idempotent_notification";
  const eventResultSet = await models.ResultSet.findByPk(resultSetId);
  smokeStage = "idempotent_notification_record";
  await models.sequelize.transaction(async (transaction) => {
    await notifications.recordResultSetEvent(eventResultSet, "result_ready", transaction);
    await notifications.recordResultSetEvent(eventResultSet, "result_ready", transaction);
  });
  smokeStage = "notification_list";
  let inbox = await notifications.list({ tenantId, userId: manager.userId });
  assert.equal(inbox.unreadCount, 1, "same operation event must create a single personal notification");
  assert.equal(inbox.items[0].eventType, "result_ready");

  smokeStage = "lead_allocation";
  const summary = await leadService.allocationSummary(actor, resultSetId);
  assert.equal(summary.availableCount, 3, "allocation summary reports the complete free result set");
  assert.equal(summary.resultSetId, resultSetId);
  assert.ok(Number.isFinite(Date.parse(summary.checkedAt)));
  assert.equal((await leadService.allocationSummary(actor)).availableCount, 4, "unscoped summary counts the full pool");
  await assert.rejects(leadService.allocationSummary(employeeActor, resultSetId),
    (error) => error instanceof ForbiddenException, "employees cannot read manager allocation availability");
  const allocationRequest = { recipientUserId: employee.userId, count: 2, resultSetId, idempotencyKey: "db-smoke-lead-allocation-01" };
  const allocation = await leadService.allocate(actor, allocationRequest);
  assert.equal(allocation.count, 2);
  assert.equal((await leadService.allocationSummary(actor, resultSetId)).availableCount, 1, "summary excludes assigned leads");
  assert.equal((await leadService.allocationSummary(actor)).availableCount, 2, "unscoped availability still includes the second result set");
  assert.equal((await models.BusinessLead.findByPk(otherSetLead.leadId)).assignedToUserId, null, "a scoped allocation leaves other result sets untouched");
  assert.equal((await leadService.allocate(actor, allocationRequest)).replayed, true, "retry must replay its original assignment");
  await assert.rejects(leadService.allocate(actor, { ...allocationRequest, count: 2, idempotencyKey: "db-smoke-lead-allocation-02" }),
    (error) => {
      assert.ok(error instanceof ConflictException, "insufficient pool returns a conflict");
      const response = error.getResponse();
      assert.equal(response.code, "LEAD_POOL_CHANGED", "pool conflicts have a stable machine-readable code");
      assert.equal(response.availableCount, 1, "pool conflicts include the current available count");
      return true;
    }, "insufficient pool must reject the entire requested amount");
  assert.equal((await leadService.allocationSummary(actor, resultSetId)).availableCount, 1,
    "a rejected multi-lead allocation leaves every remaining lead untouched");
  const concurrentAllocations = await Promise.allSettled([
    leadService.allocate(actor, { ...allocationRequest, recipientUserId: manager.userId, resultSetId: otherResultSetId, count: 1, idempotencyKey: "db-smoke-lead-allocation-03" }),
    leadService.allocate(actor, { ...allocationRequest, recipientUserId: manager.userId, resultSetId: otherResultSetId, count: 1, idempotencyKey: "db-smoke-lead-allocation-04" }),
  ]);
  assert.equal(concurrentAllocations.filter((item) => item.status === "fulfilled").length, 1,
    "concurrent allocations in another result set for the same final lead have one winner");
  assert.equal(concurrentAllocations.filter((item) => item.status === "rejected"
    && item.reason instanceof ConflictException).length, 1, "the losing concurrent allocation reports a pool conflict");
  assert.equal((await leadService.allocationSummary(actor, otherResultSetId)).availableCount, 0,
    "concurrent allocation does not leave a duplicate or unassigned lead behind");
  assert.equal((await leadService.allocationSummary(actor, resultSetId)).availableCount, 1,
    "the concurrent scoped allocation leaves the first result set untouched");
  assert.equal((await leadService.allocationSummary(actor)).availableCount, 1,
    "the concurrent scoped allocation consumes only one lead across the pool");

  smokeStage = "owner_status_and_permissions";
  const status = await leadService.updateContactStatus(employeeActor, allocation.leadIds[0], { status: "offer_accepted", expectedVersion: 1 });
  assert.equal(status.contactStatusVersion, 2);
  await assert.rejects(leadService.updateContactStatus(employeeActor, allocation.leadIds[0], { status: "not_interested", expectedVersion: 1 }),
    (error) => error instanceof ConflictException, "stale contact status version must conflict");
  await assert.rejects(leadService.updateContactStatus(actor, allocation.leadIds[0], { status: "not_interested", expectedVersion: 2 }),
    (error) => error instanceof NotFoundException, "manager cannot edit an employee's assigned contact status");

  smokeStage = "shared_pool_list";
  const listed = await leadService.list(employeeActor, { scope: "pool", resultSetId, limit: "10" });
  assert.equal(listed.items.length, 3, "active employee can read the complete shared results pool");
  assert.equal(listed.items.filter((item) => item.assignedToUserId === employee.userId).length, 2);
  const start = new Date(now.getTime() - 60_000).toISOString();
  const end = new Date(now.getTime() + 60_000).toISOString();
  smokeStage = "contact_report";
  const report = await new ContactReportService().overview(actor, start, end, resultSetId);
  assert.deepEqual(report.summary, { total: 3, unassigned: 1, assigned: 2, notContacted: 2, accepted: 1, notInterested: 0 });
  assert.equal(report.employees[0].username, employee.username);
  assert.equal(report.employees[0].accepted, 1);

  smokeStage = "role_dashboards";
  const managerDashboard = await new DashboardService().get({ tenantId, userId: manager.userId, role: "manager" });
  const employeeDashboard = await new DashboardService().get({ tenantId, userId: employee.userId, role: "operator" });
  assert.equal(managerDashboard.metrics.team.unassigned, 1);
  assert.equal(managerDashboard.metrics.team.assigned, 3);
  assert.equal(managerDashboard.unreadNotifications, 1);
  assert.equal(employeeDashboard.metrics.myLeads.total, 2);
  assert.equal(employeeDashboard.metrics.myLeads.accepted, 1);
  assert.equal(employeeDashboard.metrics.team, null);

  smokeStage = "notification_ownership";
  const notificationId = inbox.items[0].id;
  await assert.rejects(notifications.markRead({ tenantId, userId: employee.userId }, notificationId),
    (error) => error instanceof NotFoundException, "a different user cannot read another user's notification");
  await notifications.markRead({ tenantId, userId: manager.userId }, notificationId);
  inbox = await notifications.list({ tenantId, userId: manager.userId });
  assert.equal(inbox.unreadCount, 0);

  smokeStage = "team_count";
  const employees = await team.list(actor);
  assert.equal(employees.items.some((item) => item.userId === employee.userId && item.leadCount === 2), true);
  smokeStage = "employee_assignment_release";
  const releaseVersion = (await models.BusinessLead.findByPk(allocation.leadIds[0])).assignmentVersion;
  const released = await leadService.releaseAssignment(employeeActor, allocation.leadIds[0], { expectedVersion: releaseVersion });
  assert.equal(released.assignedToUserId, null, "the employee can release only their own assignment");
  assert.equal((await models.BusinessLead.findByPk(allocation.leadIds[0])).resultStatus, "ready", "release retains the lead record and result");
  assert.equal((await leadService.allocationSummary(actor, resultSetId)).availableCount, 2, "released lead returns to the manager pool");
  const otherEmployee = await createAccount(tenantId, "operator", "OtherEmployee", now);
  await models.BusinessLead.update({ createdAt: new Date(now.getTime() - 1_000) }, { where: { leadId: allocation.leadIds[0] } });
  const reassigned = await leadService.allocate(actor, { recipientUserId: otherEmployee.userId, count: 1,
    resultSetId, idempotencyKey: "db-smoke-lead-reassignment-01" });
  assert.deepEqual(reassigned.leadIds, [allocation.leadIds[0]], "the released lead is reassigned to another employee");
  await assert.rejects(leadService.releaseAssignment(employeeActor, allocation.leadIds[0], { expectedVersion: released.assignmentVersion }),
    (error) => error instanceof NotFoundException, "employee cannot release a different lead's assignment");
  console.log("BUSINESS_LEADS_DB_PASS managerCreatesOperator=true executeIndependent=true exactAllocation=true replayIdempotent=true insufficientPoolAtomic=true ownerOnlyStatus=true ownerOnlyAssignmentRelease=true releasePreservesLead=true sharedRead=true contactReport=true roleDashboards=true personalNotification=true teamCounts=true");
  } catch (error) {
    const query = error?.sql ?? error?.parent?.sql;
    if (query) console.error("BUSINESS_LEADS_SQL_ERROR", error?.parent?.position ?? error?.position ?? "", query);
    error.message = `business_leads_${smokeStage}: ${error?.parent?.message ?? error?.message ?? "UNKNOWN"}${query ? ` SQL=${query}` : ""}`;
    throw error;
  } finally {
    if (previousBindingKey === undefined) delete process.env.PRIVILEGED_ACTION_BINDING_KEY;
    else process.env.PRIVILEGED_ACTION_BINDING_KEY = previousBindingKey;
  }
};
