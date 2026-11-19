// Run 6.9 (P-127, D-57): a host release — three images built once from one
// commit, saved as archives, scanned, listed here by image id. The scans can
// only say "pass": the builder writes this file after all three exited 0.
import { z } from "zod";

const imageId = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const RELEASE_IMAGES = ["api", "provisioner", "ops"] as const;

const releaseImageSchema = z.strictObject({
  name: z.enum(RELEASE_IMAGES),
  imageId,
  archive: z.string().regex(/^[a-z]+\.tar$/),
  archiveSha256: sha256,
});

export const releaseSchema = z
  .strictObject({
    format: z.literal("mykey-host-release/1"),
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    builtAt: z.iso.datetime(),
    images: z.array(releaseImageSchema).length(RELEASE_IMAGES.length),
    baseDigests: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), imageId),
    migrations: z.strictObject({ last: z.string().regex(/^\d{4}_[a-z0-9_]+$/) }),
    scans: z.strictObject({
      secrets: z.literal("pass"),
      dependencies: z.literal("pass"),
      images: z.literal("pass"),
    }),
  })
  .refine((r) => new Set(r.images.map((i) => i.name)).size === RELEASE_IMAGES.length, {
    message: "each image exactly once",
    path: ["images"],
  });

export type Release = z.infer<typeof releaseSchema>;
export type ReleaseImageName = (typeof RELEASE_IMAGES)[number];
