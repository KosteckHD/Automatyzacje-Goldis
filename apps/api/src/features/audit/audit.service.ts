import { Inject, Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { type AuditEventInput, AuditRepository } from "./audit.repository";

@Injectable()
export class AuditService {
  constructor(@Inject(AuditRepository) private readonly repository: AuditRepository) {}

  record(input: AuditEventInput, transaction?: Transaction): Promise<void> {
    return this.repository.record(input, transaction);
  }
}
