import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, type SessionPrincipal, verifyCsrfRequest } from "../auth";

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const roles = new Set(["admin", "manager", "operator", "reviewer", "auditor"]);
export const toolIdPattern = /^[a-z0-9][a-z0-9-]{1,79}$/;
export const maxPageSize = 100;
export function requireCsrf(request: Request): void {
  if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
}

export function principal(request: Request): SessionPrincipal {
  const actor = readSessionPrincipal(request);
  if (!actor) throw new ForbiddenException();
  return actor;
}

export function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Nieprawidłowe dane żądania");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new BadRequestException("Nieznane pole żądania");
  return object;
}

export function safePage(value: string | undefined, fallback = 50): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxPageSize)
    throw new BadRequestException("Nieprawidłowy limit strony");
  return parsed;
}

export function parseIso(value: string | undefined, label: string): Date {
  if (!value || !Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    throw new BadRequestException(`Nieprawidłowy parametr ${label}; wymagany jest czas ISO ze strefą`);
  }
  return new Date(value);
}

export function browserLabel(userAgent: string | undefined): string {
  const value = userAgent ?? "";
  const browser = /Edg\//.test(value)
    ? "Edge"
    : /Firefox\//.test(value)
      ? "Firefox"
      : /Chrome\//.test(value)
        ? "Chrome"
        : /Safari\//.test(value)
          ? "Safari"
          : "Przeglądarka";
  const os = /Windows/.test(value)
    ? "Windows"
    : /Mac OS/.test(value)
      ? "macOS"
      : /Android/.test(value)
        ? "Android"
        : /iPhone|iPad/.test(value)
          ? "iOS"
          : /Linux/.test(value)
            ? "Linux"
            : "inne";
  return `${browser} · ${os}`.slice(0, 80);
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
