import { join } from "node:path";

export function migrationGlob(directory: string): string {
  return join(directory, "migrations", "*.js").replace(/\\/g, "/");
}
