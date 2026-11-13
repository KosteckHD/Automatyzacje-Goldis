import type { FindOptions, Transaction } from "sequelize";
import { BusinessLead, CanonicalEntity, ResultSet } from "../../infrastructure/database/db";

/** Record reads share the caller's scope and transaction; business decisions remain in the service. */
export class LeadRecordRepository {
  getResultSet(id: string, transaction: Transaction) {
    return ResultSet.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  }

  getCanonical(options: FindOptions) {
    return CanonicalEntity.findOne(options);
  }

  getLead(options: FindOptions) {
    return BusinessLead.findOne(options);
  }
}
