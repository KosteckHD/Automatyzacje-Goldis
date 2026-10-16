import { Injectable } from "@nestjs/common";
import { QueryTypes } from "sequelize";
import { isResourceTombstoned } from "../../contracts/deletion-barrier";
import { ExportArtifact, sequelize } from "../../infrastructure/database/db";
import { ArtifactDownloadError, type ReadyArtifact } from "./artifact-download.contract";

@Injectable()
export class ArtifactDownloadRepository {
  withReadyArtifact<T>(runId: string, readArtifact: (artifact: ReadyArtifact) => Promise<T>) {
    return sequelize.transaction(async (transaction) => {
      const runRows = await sequelize.query<{ id: string; status: string; batchId: string }>(
        'SELECT id, status, batch_id AS "batchId" FROM automation_runs WHERE id = :runId FOR KEY SHARE',
        { replacements: { runId }, type: QueryTypes.SELECT, transaction },
      );
      const run = runRows[0];
      if (!run) throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
      if (
        run.status !== "completed" ||
        (await isResourceTombstoned("run", runId, transaction)) ||
        (await isResourceTombstoned("import", run.batchId, transaction))
      ) {
        throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
      }
      const artifact = await ExportArtifact.findOne({
        where: { runId, state: "ready" },
        order: [
          ["readyAt", "DESC"],
          ["createdAt", "DESC"],
        ],
        transaction,
      });
      if (
        !artifact ||
        artifact.policyCount < 1 ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
        (await isResourceTombstoned("artifact", artifact.artifactId, transaction))
      ) {
        throw new ArtifactDownloadError("ARTIFACT_NOT_FOUND");
      }
      return readArtifact({
        artifactId: artifact.artifactId,
        storageKey: artifact.storageKey,
        fileName: artifact.fileName,
        sha256: artifact.sha256,
        policyCount: artifact.policyCount,
      });
    });
  }
}
