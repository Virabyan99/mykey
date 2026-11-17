# The MyKey operator image (Run 6.2, P-111, D-47). Build from the repository root:
#
#   docker build --platform linux/amd64 -f apps/ops/Dockerfile -t mykey-ops .
#
# It runs one operator command per container, started on a host by
# /opt/mykey/hosts/ops-run.sh <job> -- <command> [flags]. It runs the TypeScript
# sources directly (Node strips the types) and holds production dependencies
# only. No secret and no certificate is in the image: the job's files are
# mounted under /run/mykey.

FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/audit/package.json packages/audit/
COPY packages/operations/package.json packages/operations/
COPY packages/openbao/package.json packages/openbao/
COPY packages/auth/package.json packages/auth/
COPY packages/backup/package.json packages/backup/
COPY apps/ops/package.json apps/ops/
RUN pnpm install --frozen-lockfile --prod --filter "@mykey/ops..."
# As in the API image: better-auth's optional peers are linked from the
# workspace root and nothing ops runs imports them.
RUN rm -rf node_modules/.pnpm/esbuild@* node_modules/.pnpm/@esbuild+* \
      node_modules/.pnpm/@esbuild-kit+* node_modules/.pnpm/drizzle-kit@* \
      node_modules/.pnpm/vite@* node_modules/.pnpm/vitest@* node_modules/.pnpm/@vitest+* \
      node_modules/.pnpm/vue@* node_modules/.pnpm/@vue+* node_modules/.pnpm/@babel+* \
      node_modules/.pnpm/typescript@6.0.3 node_modules/.pnpm/csstype@3.2.3 \
      node_modules/.pnpm/entities@7.0.1 node_modules/.pnpm/estree-walker@2.0.2 \
      node_modules/.pnpm/magic-string@0.30.21
COPY packages/contracts/src packages/contracts/src
COPY packages/db/src packages/db/src
COPY packages/audit/src packages/audit/src
COPY packages/operations/src packages/operations/src
COPY packages/openbao/src packages/openbao/src
COPY packages/auth/src packages/auth/src
COPY packages/backup/src packages/backup/src
# The organization policies provision-organization renders.
COPY infra/openbao/policies infra/openbao/policies
COPY apps/ops/src apps/ops/src

FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Run 6.9 (P-127): no package manager in a runtime image.
RUN rm -rf /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
USER 1000:1000
# Node's permission model (PO-11): read its code and the job's mounted files;
# write only under /run/mykey (the job's own directories, mounted by ops-run.sh).
ENTRYPOINT ["node", "--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/mykey", "--allow-fs-read=/tmp/*", "--allow-fs-write=/run/mykey/*", "--allow-fs-write=/tmp/*", "apps/ops/src/main.ts"]
