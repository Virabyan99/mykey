# Run 9.3 (P-164, D-71): the agent runner, a test harness of the agent
# experiment (docs/runbooks/agent-experiment.md). Never part of a release.
#
# The build context is this directory with, under mykey-release/, the CLI's
# release files (cli-v0.2.0: install.sh, the archive, SHA256SUMS) and the
# official Node archive install.sh pins, fetched as consumer-deploy.md steps
# 1 to 3 fetch them; and digests.json, written by the staging seed (digests
# only). No build argument and no layer holds a token: the token is a Docker
# secret file mounted at run time, readable by the runner's user only.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
COPY mykey-release/ /tmp/mykey-release/
# The sums first, as consumer-local.md step 2; install.sh checks the archive
# and the Node runtime against its own pinned sums.
RUN cd /tmp/mykey-release \
  && sha256sum --ignore-missing -c SHA256SUMS \
  && HOME=/opt/mykey sh /tmp/mykey-release/install.sh \
  && rm -rf /tmp/mykey-release \
  && rm -rf /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && install -d -m 0700 -o 1000 -g 1000 /var/log/agent-runner
ENV PATH=/opt/mykey/.local/bin:$PATH
COPY runner.ts /runner/runner.ts
COPY fixture-check.mjs /fixture/fixture-check.mjs
COPY digests.json /fixture/digests.json
USER 1000:1000
EXPOSE 8790
ENTRYPOINT ["node", "/runner/runner.ts"]
