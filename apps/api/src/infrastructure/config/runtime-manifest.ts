export type RuntimeBuildEnvironment = Readonly<Record<string, string | undefined>>;

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const commitPattern = /^[a-fA-F0-9]{7,40}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;

/** Public-safe build identifiers only; malformed values never become arbitrary response text. */
export function runtimeBuildManifest(environment: RuntimeBuildEnvironment) {
  const version = environment.GOLDIS_BUILD_VERSION?.trim() ?? "";
  const commit = environment.GOLDIS_BUILD_COMMIT?.trim() ?? "";
  const imageDigest = environment.GOLDIS_IMAGE_DIGEST?.trim() ?? "";
  return {
    version: versionPattern.test(version) ? version : "0.1.0",
    commit: commitPattern.test(commit) ? commit.toLowerCase() : null,
    imageDigest: imageDigestPattern.test(imageDigest) ? imageDigest : null,
  } as const;
}
