import { SetMetadata } from "@nestjs/common";

export const originOnlyMetadataKey = "goldis:origin-only";

/** Marks operations such as logout that are safe with Origin validation alone. */
export function OriginOnly() {
  return SetMetadata(originOnlyMetadataKey, true);
}
