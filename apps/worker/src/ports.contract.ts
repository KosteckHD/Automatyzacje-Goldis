import type { IdentityProvider, PolicyProvider, RunRepository, Clock } from "./ports.js";

/** Compile-only fixture proving the worker ports can be implemented without a browser library. */
export class ContractOnlyAdapterFixture implements IdentityProvider, PolicyProvider, RunRepository, Clock {
  async findIdentity(): ReturnType<IdentityProvider["findIdentity"]> {
    return { kind: "not_found" };
  }

  async verifyAndReadOc(): ReturnType<PolicyProvider["verifyAndReadOc"]> {
    return { kind: "portal_error", errorCode: "PORTAL_SESSION_EXPIRED" };
  }

  async load(): ReturnType<RunRepository["load"]> {
    return null;
  }

  async transition(): ReturnType<RunRepository["transition"]> {
    return false;
  }

  async saveIdentity(): ReturnType<RunRepository["saveIdentity"]> {
    return undefined;
  }

  now(): Date {
    return new Date("2026-01-01T00:00:00.000Z");
  }
}
