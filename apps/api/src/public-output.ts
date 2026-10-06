import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  CallHandler,
} from "@nestjs/common";
import type { Response } from "express";
import { map, type Observable } from "rxjs";

const peselLike = /(?<!\d)\d{11}(?!\d)/g;
const windowsAbsolutePath = /(^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+\\[^\\/\s]+\\)[^\r\n"'<>]*/g;
const posixAbsolutePath = /(^|[\s("'=])\/(?!\/)(?:[^\s/"'<>]+\/)*[^\s/"'<>]*/g;
const privateField = /pesel|path|storagekey|artifactroot/i;

export function sanitizePublicText(value: string): string {
  return value
    .replace(peselLike, "[ukryto]")
    .replace(windowsAbsolutePath, (_match, prefix: string) => `${prefix}[ścieżka ukryta]`)
    .replace(posixAbsolutePath, (_match, prefix: string) => `${prefix}[ścieżka ukryta]`);
}

export function sanitizePublicFileName(value: string, fallback = "plik.xlsx"): string {
  const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const safe = sanitizePublicText(basename)
    .replace(/[\u0000-\u001f\u007f\r\n"\\/]/g, "_")
    .trim()
    .slice(0, 180);
  return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

/** Removes sensitive fields and masks sensitive/path-like values from public JSON. */
export function sanitizePublicOutput<T>(value: T): T {
  if (typeof value === "string") return sanitizePublicText(value) as T;
  if (!value || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePublicOutput(item)) as T;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (privateField.test(key)) continue;
    result[key] = sanitizePublicOutput(item);
  }
  return result as T;
}

@Injectable()
export class PublicOutputInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => sanitizePublicOutput(value)));
  }
}

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const body = exception instanceof HttpException
      ? sanitizePublicOutput(exception.getResponse())
      : { statusCode: 500, message: "Wystąpił błąd serwera" };
    response.status(status).json(sanitizePublicOutput({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : { message: body }),
    }));
  }
}
