# Run 5.8 consumer fixture (P-100). The build context is this directory with
# the CLI's release files, the Node archive for the build machine and
# secrets-launch.sh under mykey-release/ (docs/runbooks/consumer-deploy.md).
# No build argument and no layer holds a token: the token is a file mounted
# when the container runs.
FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore \
  --require-hashes --only-binary=:all: --no-deps -r requirements.txt
COPY main.py ./

FROM app
COPY mykey-release/ /tmp/mykey-release/
RUN HOME=/opt/mykey sh /tmp/mykey-release/install.sh \
  && install -m 0755 /tmp/mykey-release/secrets-launch.sh /usr/local/bin/secrets-launch.sh \
  && rm -rf /tmp/mykey-release
ENV PATH=/opt/mykey/.local/bin:$PATH
ENTRYPOINT ["secrets-launch.sh", "--"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]
