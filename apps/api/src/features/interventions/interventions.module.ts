import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { AuthChallengeController } from "./auth-challenge.controller";
import { AuthChallengeRepository } from "./auth-challenge.repository";
import { AuthChallengeService } from "./auth-challenge.service";
import { InterventionController } from "./interventions.controller";
import { InterventionRepository } from "./interventions.repository";
import { InterventionService } from "./interventions.service";
import { ManualDataController } from "./manual-data.controller";
import { ManualDataRepository } from "./manual-data.repository";
import { ManualDataService } from "./manual-data.service";
import { WorkerCodeForwarder } from "./worker-code-forwarder";

@Module({
  imports: [DatabaseModule, AuthModule, AuthorizationModule],
  controllers: [AuthChallengeController, InterventionController, ManualDataController],
  providers: [
    AuthChallengeService,
    AuthChallengeRepository,
    InterventionService,
    InterventionRepository,
    ManualDataRepository,
    ManualDataService,
    WorkerCodeForwarder,
  ],
  exports: [
    AuthChallengeService,
    AuthChallengeRepository,
    InterventionService,
    InterventionRepository,
    ManualDataService,
    WorkerCodeForwarder,
  ],
})
export class InterventionsModule {}
