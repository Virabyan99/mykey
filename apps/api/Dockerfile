# The MyKey API. Build from the repository root:
#
#   docker build --platform linux/amd64 -f apps/api/Dockerfile -t mykey-api .
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
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter "@mykey/api..."
COPY packages/contracts/src packages/contracts/src
COPY packages/db/src packages/db/src
COPY apps/api/src apps/api/src

FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# The `node` user of the image. The compose file repeats it.
USER 1000:1000
EXPOSE 8443
# Node's permission model (PO-11): the process may read its code and the
# mounted settings, and nothing else on the file system; it may not write,
# start a child process or a worker, or load a native add-on.
ENTRYPOINT ["node", "--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/mykey", "apps/api/src/server.ts"]
