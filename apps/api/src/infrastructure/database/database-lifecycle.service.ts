import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { Sequelize } from "sequelize";
import { API_DATABASE, releaseApiDatabase } from "./database.factory";

@Injectable()
export class DatabaseLifecycleService implements OnApplicationShutdown {
  constructor(@Inject(API_DATABASE) private readonly connection: Sequelize) {}

  async onApplicationShutdown(): Promise<void> {
    await releaseApiDatabase(this.connection);
  }
}
