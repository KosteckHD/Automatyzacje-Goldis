import { loadApiAuthMailConfig } from "../../infrastructure/config";
import type { AuthMailConfig } from "./auth-mail-settings";

export type { AuthMailConfig, AuthMailProviderKind } from "./auth-mail-settings";
export { assertAuthMailProductionConfiguration } from "./auth-mail-settings";

/** Uses the API startup snapshot unless an explicit environment is supplied for validation or tests. */
export function readAuthMailConfig(environment?: Readonly<Record<string, string | undefined>>): AuthMailConfig {
  return loadApiAuthMailConfig(environment);
}
