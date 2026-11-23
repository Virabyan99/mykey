# Run 10.4 Task C (D-79): the agent of the guide's proof, a test harness, never
# part of a release. Claude Code in headless mode, at the version
# tools/agent-experiment/lock.json pins, in a container that stays up for the
# whole run: each turn is a `docker exec`, and the session is resumed. The
# agent has a shell, the file tools and web fetch: it must install the CLI and
# change an application. The API key is a file mounted read-only at run time
# and read by settings.json's apiKeyHelper: it is in no layer, no argument and
# no environment variable. curl and git are what a developer's machine has.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG CLAUDE_CODE_VERSION=2.1.319
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force
ENV DISABLE_TELEMETRY=1 \
  DISABLE_ERROR_REPORTING=1 \
  DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  NEXT_TELEMETRY_DISABLED=1
COPY settings.json /home/node/.claude/settings.json
RUN chown -R 1000:1000 /home/node/.claude
USER 1000:1000
WORKDIR /home/node/app
ENTRYPOINT ["sleep", "infinity"]
