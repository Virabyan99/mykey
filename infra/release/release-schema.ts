// Run 6.9 (P-127): release.json of a host release. The schema lives in
// @mykey/contracts (where zod resolves); host.ts and the builder read it here.
export {
  RELEASE_IMAGES,
  releaseSchema,
  type Release,
  type ReleaseImageName,
} from "@mykey/contracts";
