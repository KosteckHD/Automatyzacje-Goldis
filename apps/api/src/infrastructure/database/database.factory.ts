import type { Sequelize } from "sequelize";
import { acquireDatabaseConnection, releaseDatabaseConnection, resolveDefaultDatabaseUrl } from "./db";
import { composePersistenceModels } from "../../composition/persistence-models";

export const API_DATABASE = Symbol.for("goldis.api.database");

export function createApiDatabase(connectionString?: string): Sequelize {
  return acquireDatabaseConnection(connectionString ?? resolveDefaultDatabaseUrl(), composePersistenceModels);
}

export function releaseApiDatabase(connection: Sequelize): Promise<void> {
  return releaseDatabaseConnection(connection);
}
