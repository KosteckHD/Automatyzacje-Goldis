import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export class ToolModel extends Model {
  declare toolId: string;

  declare displayName: string;

  declare description: string;

  declare status: "available" | "maintenance" | "disabled";

  declare sortOrder: number;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  ToolModel,
  {
    toolId: { type: DataTypes.STRING(80), primaryKey: true, field: "tool_id" },

    displayName: { type: DataTypes.STRING(160), allowNull: false, field: "display_name" },

    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    status: { type: DataTypes.STRING(20), allowNull: false },

    sortOrder: { type: DataTypes.INTEGER, allowNull: false, field: "sort_order" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "tools", timestamps: false, modelName: "Tool" },
);

export class ToolGrantModel extends Model {
  declare tenantId: string;

  declare toolId: string;

  declare userId: string;

  declare canDiscover: boolean;

  declare canExecute: boolean;

  declare canViewResults: boolean;

  declare canDownloadResults: boolean;

  declare grantedBy: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare version: number;
}

registerModel(
  ToolGrantModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },

    toolId: { type: DataTypes.STRING(80), primaryKey: true, field: "tool_id" },

    userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },

    canDiscover: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_discover" },

    canExecute: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_execute" },

    canViewResults: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_view_results" },

    canDownloadResults: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_download_results" },

    grantedBy: { type: DataTypes.UUID, allowNull: true, field: "granted_by" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    version: { type: DataTypes.INTEGER, allowNull: false },
  },
  { tableName: "tool_grants", timestamps: false, modelName: "ToolGrant" },
);

export class ToolSettingsModel extends Model {
  declare tenantId: string;

  declare toolId: string;

  declare enabledForNewRuns: boolean;

  declare maxNewRunsPerHour: number | null;

  declare allowedLocalStart: string | null;

  declare allowedLocalEnd: string | null;

  declare timezone: string;

  declare updatedBy: string | null;

  declare updatedAt: Date;

  declare version: number;
}

registerModel(
  ToolSettingsModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },

    toolId: { type: DataTypes.STRING(80), primaryKey: true, field: "tool_id" },

    enabledForNewRuns: { type: DataTypes.BOOLEAN, allowNull: false, field: "enabled_for_new_runs" },

    maxNewRunsPerHour: { type: DataTypes.INTEGER, allowNull: true, field: "max_new_runs_per_hour" },

    allowedLocalStart: { type: DataTypes.TIME, allowNull: true, field: "allowed_local_start" },

    allowedLocalEnd: { type: DataTypes.TIME, allowNull: true, field: "allowed_local_end" },

    timezone: { type: DataTypes.STRING(80), allowNull: false },

    updatedBy: { type: DataTypes.UUID, allowNull: true, field: "updated_by" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    version: { type: DataTypes.INTEGER, allowNull: false },
  },
  { tableName: "tool_settings", timestamps: false, modelName: "ToolSettings" },
);

export type Tool = InstanceType<typeof ToolModel>;
export type ToolGrant = InstanceType<typeof ToolGrantModel>;
export type ToolSettings = InstanceType<typeof ToolSettingsModel>;
