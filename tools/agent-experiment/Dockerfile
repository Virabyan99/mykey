# Run 9.4 (D-71, FR-1.99): the agent experiment's agent, a test harness, never
# part of a release (docs/runbooks/agent-experiment.md). Claude Code in
# headless mode, at the version lock.json pins, with one file it may run
# (/fixture/ask.mjs, which sends a body to the runner) and nothing else of
# MyKey. The API key is a file mounted read-only at run time and read by
# settings.json's apiKeyHelper: it is in no layer, no argument and no
# environment variable.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG CLAUDE_CODE_VERSION=2.1.319
RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force
ENV DISABLE_TELEMETRY=1 \
  DISABLE_ERROR_REPORTING=1 \
  DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
COPY ask.mjs /fixture/ask.mjs
COPY settings.json /home/node/.claude/settings.json
RUN chown -R 1000:1000 /home/node/.claude
USER 1000:1000
WORKDIR /home/node
ENTRYPOINT ["claude"]
