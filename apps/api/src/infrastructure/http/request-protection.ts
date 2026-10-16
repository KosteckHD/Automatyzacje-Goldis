import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { loadApiRuntimeConfig } from "../config";
import { verifyCsrfRequest } from "../../features/auth";
import { originOnlyMetadataKey } from "./request-metadata";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function isExpectedOrigin(request: Pick<Request, "headers">): boolean {
  const suppliedOrigin = request.headers.origin;
  const runtimeConfig = loadApiRuntimeConfig();
  const configuredOrigin = runtimeConfig.publicAppOrigin?.trim() || "http://127.0.0.1:3000";
  if (typeof suppliedOrigin !== "string" || suppliedOrigin === "null") return false;

  try {
    const expected = new URL(configuredOrigin);
    const supplied = new URL(suppliedOrigin);
    const expectedIsOrigin = expected.pathname === "/" && !expected.search && !expected.hash
      && !expected.username && !expected.password;
    const productionOriginIsSecure = runtimeConfig.nodeEnvironment !== "production"
      || (expected.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(expected.hostname));
    return expectedIsOrigin && productionOriginIsSecure && supplied.origin === expected.origin;
  } catch {
    return false;
  }
}

function hasSessionCookie(request: Request): boolean {
  return request.headers.cookie?.split(";").some((part) => part.trim().startsWith("goldis_session=")) ?? false;
}

@Injectable()
export class RequestProtectionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method || "GET").toUpperCase();
    if (safeMethods.has(method)) return true;

    const fetchSite = request.headers["sec-fetch-site"];
    if ((typeof fetchSite === "string" && fetchSite !== "same-origin") || !isExpectedOrigin(request)) {
      throw new ForbiddenException("Żądanie musi pochodzić z panelu Goldis");
    }
    const originOnly = Reflect.getMetadata(originOnlyMetadataKey, context.getHandler()) === true;
    if (!originOnly && hasSessionCookie(request) && !verifyCsrfRequest(request)) {
      throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    }
    return true;
  }
}
