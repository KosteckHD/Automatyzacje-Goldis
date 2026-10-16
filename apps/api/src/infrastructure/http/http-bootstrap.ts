import type { INestApplication, NestApplicationOptions, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import type { NextFunction, Request, Response } from "express";
import { isIP } from "node:net";
import { loadApiRuntimeConfig } from "../config";

export type ApiRequestBudget = (clientIp: string) => Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>>;

export function apiRequestBudgetMiddleware(budget: ApiRequestBudget) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const decision = await budget(request.ip || request.socket.remoteAddress || "invalid");
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(Math.max(1, decision.retryAfterSeconds)));
        response.status(429).json({ message: "Zbyt wiele żądań" });
        return;
      }
      next();
    } catch {
      response.status(503).json({ message: "Usługa jest chwilowo niedostępna" });
    }
  };
}

function normalizedProxyAddress(value: string): string {
  const address = value.replace(/^::ffff:/i, "");
  if (isIP(address) === 4) return address.split(".").map((part) => String(Number(part))).join(".");
  if (isIP(address) === 6) return new URL("http://[" + address + "]/").hostname.slice(1, -1);
  return "";
}

export function trustedProxyAddresses(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const addresses = value.split(",").map((part) => normalizedProxyAddress(part.trim()));
  if (addresses.some((address) => !address)) throw new Error("TRUST_PROXY_IPS_INVALID");
  return [...new Set(addresses)];
}

/** Shared by the production entry point and HTTP startup regression tests. */
export async function createHttpApplication(
  module: Type<unknown>,
  options: NestApplicationOptions = {},
  beforeBodyParsers?: (app: INestApplication) => void,
  runtimeConfig?: Readonly<{ trustProxyIps: string | undefined }>,
) {
  // Nest detects parsers by middleware name, even when a parser is path-scoped.
  // Register both limits explicitly so the worker parser cannot suppress JSON
  // parsing for login and all other public mutation routes.
  const app = await NestFactory.create(module, { ...options, bodyParser: false });
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  const trustedProxies = new Set(trustedProxyAddresses(
    runtimeConfig ? runtimeConfig.trustProxyIps : loadApiRuntimeConfig().trustProxyIps,
  ));
  app.getHttpAdapter().getInstance().set("trust proxy", (address: string) => trustedProxies.has(normalizedProxyAddress(address)));
  beforeBodyParsers?.(app);
  app.use("/api/internal/worker-runs", json({ limit: "5mb" }));
  app.use(json({ limit: "100kb" }));
  app.use(urlencoded({ extended: true, limit: "100kb" }));
  app.setGlobalPrefix("api");
  return app;
}
