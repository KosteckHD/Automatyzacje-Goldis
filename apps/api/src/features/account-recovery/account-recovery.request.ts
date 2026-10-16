import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { verifyCsrfRequest } from "../auth";

export function strictBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Nieprawidłowe dane żądania");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new BadRequestException("Nieznane pole żądania");
  return body;
}

export function requireCsrf(request: Request): void {
  if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
}

export function clientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}
