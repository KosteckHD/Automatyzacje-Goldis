import { BadRequestException } from "@nestjs/common";
import { roles, strictObject } from "./admin.support";

export type AdminUserRole = "admin" | "manager" | "operator" | "reviewer" | "auditor";

export type AdminCreateUserInput = Readonly<{
  username: string;
  password: string;
  role: AdminUserRole;
  confirmationToken: unknown;
  idempotencyKey: unknown;
}>;

export type AdminSetToolGrantInput = Readonly<{
  canDiscover: boolean;
  canExecute: boolean;
  canViewResults: boolean;
  canDownloadResults: boolean;
  expectedVersion: number;
  confirmationToken: unknown;
  idempotencyKey: unknown;
}>;

export type AdminSetDeletionGrantInput = Readonly<{
  canDeleteData: boolean;
  expectedVersion: number;
  confirmationToken: unknown;
  idempotencyKey: unknown;
}>;

export type AdminRevokeToolGrantInput = Readonly<{
  expectedVersion: number;
  confirmationToken: unknown;
  idempotencyKey: unknown;
}>;

export function parseAdminCreateUserInput(input: unknown): AdminCreateUserInput {
  const body = strictObject(input, ["username", "password", "role", "confirmationToken", "idempotencyKey"]);
  if (
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    typeof body.role !== "string" ||
    !roles.has(body.role)
  ) {
    throw new BadRequestException("Nieprawidłowe dane nowego użytkownika");
  }
  return {
    username: body.username,
    password: body.password,
    role: body.role as AdminUserRole,
    confirmationToken: body.confirmationToken,
    idempotencyKey: body.idempotencyKey,
  };
}

function parseExpectedVersion(value: unknown, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new BadRequestException("Nieprawidłowa wersja grantu");
  }
  return Number(value);
}

export function parseAdminSetToolGrantInput(input: unknown): AdminSetToolGrantInput {
  const body = strictObject(input, [
    "canDiscover",
    "canExecute",
    "canViewResults",
    "canDownloadResults",
    "expectedVersion",
    "confirmationToken",
    "idempotencyKey",
  ]);
  if (
    typeof body.canDiscover !== "boolean" ||
    typeof body.canExecute !== "boolean" ||
    typeof body.canViewResults !== "boolean" ||
    typeof body.canDownloadResults !== "boolean"
  ) {
    throw new BadRequestException("Nieprawidłowy zestaw uprawnień");
  }
  return {
    canDiscover: body.canDiscover || body.canExecute,
    canExecute: body.canExecute,
    canViewResults: body.canViewResults,
    canDownloadResults: body.canDownloadResults,
    expectedVersion: parseExpectedVersion(body.expectedVersion),
    confirmationToken: body.confirmationToken,
    idempotencyKey: body.idempotencyKey,
  };
}

export function parseAdminSetDeletionGrantInput(input: unknown): AdminSetDeletionGrantInput {
  const body = strictObject(input, ["canDeleteData", "expectedVersion", "confirmationToken", "idempotencyKey"]);
  if (typeof body.canDeleteData !== "boolean") throw new BadRequestException("Nieprawidłowy grant usuwania danych");
  return {
    canDeleteData: body.canDeleteData,
    expectedVersion: parseExpectedVersion(body.expectedVersion),
    confirmationToken: body.confirmationToken,
    idempotencyKey: body.idempotencyKey,
  };
}

export function parseAdminRevokeToolGrantInput(input: unknown): AdminRevokeToolGrantInput {
  const body = strictObject(input, ["expectedVersion", "confirmationToken", "idempotencyKey"]);
  return {
    expectedVersion: parseExpectedVersion(body.expectedVersion),
    confirmationToken: body.confirmationToken,
    idempotencyKey: body.idempotencyKey,
  };
}
