# Run 5.8 consumer fixture (P-100). The build context is this directory with
# the CLI's release files, the Node archive for the build machine and
# secrets-launch.sh under mykey-release/ (docs/runbooks/consumer-deploy.md).
# No build argument and no layer holds a token: the token is a file mounted
# when the container runs.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS app
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY next.config.mjs ./
COPY app ./app
RUN node node_modules/next/dist/bin/next build

FROM app
COPY mykey-release/ /tmp/mykey-release/
RUN HOME=/opt/mykey sh /tmp/mykey-release/install.sh \
  && install -m 0755 /tmp/mykey-release/secrets-launch.sh /usr/local/bin/secrets-launch.sh \
  && rm -rf /tmp/mykey-release
ENV PATH=/opt/mykey/.local/bin:$PATH
ENTRYPOINT ["secrets-launch.sh", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
