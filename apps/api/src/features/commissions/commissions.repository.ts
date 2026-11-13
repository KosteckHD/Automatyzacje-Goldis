import { Inject, Injectable } from "@nestjs/common";
import type {
  Attributes,
  BulkCreateOptions,
  CreateOptions,
  CreationAttributes,
  DestroyOptions,
  FindOptions,
  FindOrCreateOptions,
  Model,
  ModelStatic,
  SaveOptions,
  Sequelize,
  Transaction,
  UpdateOptions,
} from "sequelize";
import { QueryTypes } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";

@Injectable()
export class CommissionsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  findOne<T extends Model>(model: ModelStatic<T>, options: FindOptions<Attributes<T>>): Promise<T | null> {
    return model.findOne(options);
  }

  findAll<T extends Model>(model: ModelStatic<T>, options: FindOptions<Attributes<T>>): Promise<T[]> {
    return model.findAll(options);
  }

  create<T extends Model>(
    model: ModelStatic<T>,
    values: CreationAttributes<T>,
    options?: CreateOptions<Attributes<T>>,
  ): Promise<T> {
    return model.create(values, options);
  }

  bulkCreate<T extends Model>(
    model: ModelStatic<T>,
    values: CreationAttributes<T>[],
    options?: BulkCreateOptions<Attributes<T>>,
  ): Promise<T[]> {
    return model.bulkCreate(values, options);
  }

  findOrCreate<T extends Model>(
    model: ModelStatic<T>,
    options: FindOrCreateOptions<Attributes<T>, CreationAttributes<T>>,
  ): Promise<[T, boolean]> {
    return model.findOrCreate(options);
  }

  update<T extends Model>(
    model: ModelStatic<T>,
    values: Partial<Attributes<T>>,
    options: UpdateOptions<Attributes<T>>,
  ): Promise<[number]> {
    return model.update(values, options);
  }

  destroy<T extends Model>(model: ModelStatic<T>, options: DestroyOptions<Attributes<T>>): Promise<number> {
    return model.destroy(options);
  }

  save<T extends Model>(instance: T, options?: SaveOptions): Promise<T> {
    return instance.save(options);
  }

  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.database.transaction(callback);
  }

  async nextDictionaryVersion(tenantId: string): Promise<number> {
    const rows = await this.database.query<{ next: number }>(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM commission_dictionary_versions WHERE tenant_id = $1",
      { bind: [tenantId], type: QueryTypes.SELECT },
    );
    return rows[0]?.next ?? 1;
  }
}
