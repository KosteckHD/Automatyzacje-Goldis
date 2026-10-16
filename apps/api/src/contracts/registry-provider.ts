export type RegistryRawCandidate = Readonly<Record<string, unknown>>;

export type RegistryProviderResult = Readonly<{
  providerName: string;
  providerVersion: string;
  dataVersion: string | null;
  fetchedAt: Date;
  candidates: readonly RegistryRawCandidate[];
}>;
