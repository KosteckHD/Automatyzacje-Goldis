import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";
export class CanonicalEntityModel extends Model {
  declare canonicalEntityId: string;

  declare tenantId: string;

  declare nipNormalized: string | null;

  declare regon: string | null;

  declare businessName: string;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  CanonicalEntityModel,
  {
    canonicalEntityId: { type: DataTypes.UUID, primaryKey: true, field: "canonical_entity_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    nipNormalized: { type: DataTypes.STRING(10), allowNull: true, field: "nip_normalized" },

    regon: { type: DataTypes.STRING(14), allowNull: true },

    businessName: { type: DataTypes.TEXT, allowNull: false, field: "business_name" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "canonical_entities", timestamps: false, modelName: "CanonicalEntity" },
);

export class SourceEntityLinkModel extends Model {
  declare sourceRowId: string;

  declare tenantId: string;

  declare canonicalEntityId: string;

  declare matchMethod: "nip_regon_exact" | "registry_verified" | "identifier_and_name_exact" | "manual";

  declare linkedAt: Date;
}

registerModel(
  SourceEntityLinkModel,
  {
    sourceRowId: { type: DataTypes.UUID, primaryKey: true, field: "source_row_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    canonicalEntityId: { type: DataTypes.UUID, allowNull: false, field: "canonical_entity_id" },

    matchMethod: { type: DataTypes.STRING(32), allowNull: false, field: "match_method" },

    linkedAt: { type: DataTypes.DATE, allowNull: false, field: "linked_at" },
  },
  { tableName: "source_entity_links", timestamps: false, modelName: "SourceEntityLink" },
);

export class EntityGroupingConflictModel extends Model {
  declare conflictId: string;

  declare sourceRowId: string;

  declare reasonCode: string;

  declare candidateEntityIds: string[];

  declare status: "open" | "resolved";

  declare resolutionNote: string | null;

  declare resolvedBy: string | null;

  declare resolvedAt: Date | null;

  declare createdAt: Date;
}

registerModel(
  EntityGroupingConflictModel,
  {
    conflictId: { type: DataTypes.UUID, primaryKey: true, field: "conflict_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    reasonCode: { type: DataTypes.STRING(80), allowNull: false, field: "reason_code" },

    candidateEntityIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "candidate_entity_ids" },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "open" },

    resolutionNote: { type: DataTypes.TEXT, allowNull: true, field: "resolution_note" },

    resolvedBy: { type: DataTypes.STRING(128), allowNull: true, field: "resolved_by" },

    resolvedAt: { type: DataTypes.DATE, allowNull: true, field: "resolved_at" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "entity_grouping_conflicts", timestamps: false, modelName: "EntityGroupingConflict" },
);
