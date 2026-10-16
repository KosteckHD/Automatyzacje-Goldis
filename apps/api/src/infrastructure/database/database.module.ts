import { Global, Module } from "@nestjs/common";
import { API_DATABASE, createApiDatabase } from "./database.factory";
import { DatabaseLifecycleService } from "./database-lifecycle.service";

@Global()
@Module({
  providers: [
    { provide: API_DATABASE, useFactory: () => createApiDatabase() },
    DatabaseLifecycleService,
  ],
  exports: [API_DATABASE],
})
export class DatabaseModule {}
