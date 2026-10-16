import type { InitOptions, ModelAttributes, Model, ModelStatic, Sequelize } from "sequelize";

type ModelDefinition = Readonly<{
  model: ModelStatic<Model>;
  attributes: ModelAttributes<Model>;
  options: Omit<InitOptions<Model>, "sequelize">;
}>;

const modelDefinitions: ModelDefinition[] = [];
const modelAssociations: Array<() => void> = [];
let modelsBoundTo: Sequelize | null = null;

export function registerModel<M extends Model>(
  model: ModelStatic<M>,
  attributes: ModelAttributes<M>,
  options: Omit<InitOptions<M>, "sequelize">,
): void {
  modelDefinitions.push({
    model: model as unknown as ModelStatic<Model>,
    attributes: attributes as unknown as ModelAttributes<Model>,
    options: options as unknown as ModelDefinition["options"],
  });
}

export function registerAssociation(association: () => void): void {
  modelAssociations.push(association);
}

/** Bind every statically registered model exactly once to this process connection. */
export function registerPersistenceModels(connection: Sequelize): void {
  if (modelsBoundTo === connection) return;
  if (modelsBoundTo) throw new Error("PERSISTENCE_MODELS_ALREADY_BOUND_TO_ANOTHER_CONNECTION");

  for (const definition of modelDefinitions) {
    definition.model.init(definition.attributes, { ...definition.options, sequelize: connection } as never);
  }
  for (const association of modelAssociations) association();
  modelsBoundTo = connection;
}

export function persistenceModelsBoundTo(connection: Sequelize): boolean {
  return modelsBoundTo === connection;
}

export function persistenceModelsAreBound(): boolean {
  return modelsBoundTo !== null;
}
