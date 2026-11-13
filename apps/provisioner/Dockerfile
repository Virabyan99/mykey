# The MyKey provisioner (Run 3.8). Build from the repository root:
#
#   docker build --platform linux/amd64 -f apps/provisioner/Dockerfile -t mykey-provisioner .
#
# It runs the TypeScript sources directly (Node strips the types) and holds
# production dependencies only. No secret and no certificate is in the image:
# the credential directory and the CA files are mounted under /run/mykey.

FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/audit/package.json packages/audit/
COPY packages/operations/package.json packages/operations/
COPY packages/openbao/package.json packages/openbao/
COPY apps/provisioner/package.json apps/provisioner/
RUN pnpm install --frozen-lockfile --prod --filter "@mykey/provisioner..."
COPY packages/contracts/src packages/contracts/src
COPY packages/db/src packages/db/src
COPY packages/audit/src packages/audit/src
COPY packages/operations/src packages/operations/src
COPY packages/openbao/src packages/openbao/src
# The policy templates the provisioner renders (machine-env.hcl, and the
# organization policies its sweep compares).
COPY infra/openbao/policies infra/openbao/policies
COPY apps/provisioner/src apps/provisioner/src

FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER 1000:1000
# Unhealthy when the last sweep tick is older than three intervals (P-57).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "apps/provisioner/src/healthcheck.ts"]
# Node's permission model (PO-11): read its code and the mounted settings,
# write only its sweep state under /tmp/mykey-provisioner.
ENTRYPOINT ["node", "--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/mykey", "--allow-fs-read=/tmp/mykey-provisioner/*", "--allow-fs-write=/tmp/mykey-provisioner/*", "apps/provisioner/src/main.ts"]
