import type { Transaction } from "sequelize";
import type { SessionPrincipal } from "../auth/public";

export const PRIVILEGED_ACTION_PERSISTENCE = Symbol.for("goldis.privileged-action-persistence");

export type PrivilegedActionConsumption = Readonly<{
  actor: SessionPrincipal;
  confirmationId: string;
  tokenHash: string;
  action: string;
  targetId: string | null;
  payloadFingerprint: string;
  idempotencyKey: string;
  transaction: Transaction;
}>;

export type PrivilegedActionConsumptionResult =
  | Readonly<{ kind: "execute"; confirmationId: string }>
  | Readonly<{ kind: "replay"; response: unknown }>;

export interface PrivilegedActionPersistence {
  consume(input: PrivilegedActionConsumption): Promise<PrivilegedActionConsumptionResult | null>;
  complete(confirmationId: string, idempotencyKey: string, response: unknown, transaction: Transaction): Promise<void>;
}
