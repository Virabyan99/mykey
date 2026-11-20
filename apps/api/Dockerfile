# The MyKey API. Build from the repository root:
#
#   docker build --platform linux/amd64 -f apps/api/Dockerfile \
#     --build-arg MYKEY_BUILD=$(git rev-parse --short=12 HEAD) -t mykey-api .
#
# Without MYKEY_BUILD the API refuses to start (it names the setting).
#
# The image runs the TypeScript sources directly (Node strips the types) and
# holds production dependencies only. It contains no secret and no certificate:
# both are mounted at run time under /run/mykey.

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
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter "@mykey/api..."
# better-auth's optional peers drizzle-kit and vitest are linked from the
# workspace root (a dev dependency there), so a production install carries them
# and their esbuild and vite. Nothing the API runs imports them (its start-up
# refusal loads every module first); they go, with the Go binaries Trivy flags.
# Since Run 5.9 the same holds for its optional peer vue (in the workspace through
# the reference's @scalar/api-reference) and what only vue brings. Exact versions
# where the API has another version of the same package.
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
COPY apps/api/src apps/api/src

# The API reference's asset (Run 5.9, P-101): the standalone build of the pinned
# development dependency @scalar/api-reference. Only that one file and its
# version note leave this stage; nothing else of the package reaches the image.
FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS reference
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/audit/package.json packages/audit/
COPY packages/operations/package.json packages/operations/
COPY packages/openbao/package.json packages/openbao/
COPY packages/auth/package.json packages/auth/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@mykey/api"
COPY scripts/reference-asset.ts scripts/
RUN node scripts/reference-asset.ts

# The owner workspace (Run 7.1, P-134, D-59): bundled here by the pinned esbuild.
# Only apps/web/dist (an index, one script, one stylesheet, a manifest) leaves
# this stage; React and the build tool never reach the image.
FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS web
ARG MYKEY_BUILD
ENV MYKEY_BUILD=${MYKEY_BUILD}
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@mykey/web..."
COPY packages/contracts/src packages/contracts/src
COPY apps/web/src apps/web/src
COPY apps/web/build.ts apps/web/
RUN node apps/web/build.ts

FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ARG MYKEY_BUILD
ENV NODE_ENV=production
ENV MYKEY_BUILD=${MYKEY_BUILD}
WORKDIR /app
COPY --from=build /app /app
COPY --from=reference /app/apps/api/assets /app/apps/api/assets
COPY --from=web /app/apps/web/dist /app/apps/web/dist
# Run 6.9 (P-127): no package manager in a runtime image.
RUN rm -rf /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
# The `node` user of the image. The compose file repeats it.
USER 1000:1000
EXPOSE 8443
# Node's permission model (PO-11): the process may read its code and the
# mounted settings, and nothing else on the file system; it may not write,
# start a child process or a worker, or load a native add-on.
ENTRYPOINT ["node", "--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/mykey", "apps/api/src/server.ts"]
