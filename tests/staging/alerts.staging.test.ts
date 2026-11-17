// Run 6.4 Task C (P-116, FR-1.62, FR-1.63, AC-1.18, AC-1.25): every alert,
// opened, delivered and resolved on staging with the real channel. One test per
// condition: it announces itself in the host's journal (`logger -t
// mykey-drill`), causes the condition, waits for the probe's alert-log row
// `opened` with `delivered: 1`, removes the cause in `finally`, waits for
// `resolved` with `delivered: 1`, and appends its evidence line to
// docs/evidence/session-6/alerts.md. Run it condition by condition (`-t`).
//
// Causes:
//  - certificate_expiring: an entry expiring in five days through the drill
//    hook /etc/mykey/checks/certificates.extra.json;
//  - credential_expiring: a credential issued for six days, revoked after;
//  - firewall_unloaded: the drill flag /etc/mykey/checks/firewall-unloaded
//    (the ruleset is never flushed; tests/unit/hosts/checks.test.ts covers
//    the real reading);
//  - unit_failed: a throw-away unit mykey-drill.service that exits 1;
//  - audit_failing: the archive unit made to fail by a runtime drop-in;
//  - disk_low: a file allocated on the volumes' filesystem until 3 GiB are
//    left (under the 4 GiB line);
//  - backup_stale: MYKEY_BACKUP_EXPECTED=yes and no eligible pair, stated
//    through the drill hook /etc/mykey/checks/backup-newest.override (staging
//    holds a pair younger than 26 h; Run 6.5 adds the real second half);
//  - checks_unknown: openssl shadowed in the heartbeat's PATH for four
//    minutes, so the certificates cannot be read (the stub lives under
//    /var/lib/mykey: /run is mounted noexec on the hosts);
//  - heartbeat_missing: the heartbeat timer stopped;
//  - health_failing: the edge stopped (a timer starts it again after 300 s);
//  - openbao_sealed: OpenBao sealed through its API with the custody root
//    token, unsealed by a restart (cutting the KMS and restarting OpenBao
//    leaves its listener silent: the host reports `sealed: null`, which opens
//    checks_unknown, not openbao_sealed — seen in this run);
//  - kms_unreachable: the KMS cut off for 420 s while OpenBao runs;
//  - capture_frozen: the control row held in `draining` for 11 minutes (no
//    product write is attempted meanwhile).
//  - operations_unresolved: a synthetic uncertain operation of an action no
//    sweep knows, deleted after (the Session 4 and 5 drills are stale against
//    Run 6.3's rate limits).
// review_open is proven by its own drill (provisioning.staging AC-1.09), run
// again as it is.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@mykey/db";
import type pg from "pg";
import { baoFetch, type Stack } from "../harness/stack.ts";
import {
  connectStaging,
  expectSuccess,
  loadHosts,
  registerSecret,
  sshExec,
  type StagingStack,
} from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const EVIDENCE = join(ROOT, "docs", "evidence", "session-6", "alerts.md");
const PROBE = "https://mykey-probe.nomikey.com";
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const host = loadHosts().staging;
const HOOKS = "/etc/mykey/checks";
const DAY = 86_400_000;

interface Row {
  host?: string;
  condition: string;
  kind: string;
  since: number;
  at: number;
  delivered: number;
}
interface View {
  now: number;
  state: { open: Record<string, { lastAlertAt: number | null }> };
  alerts: Row[];
}

const readToken = (): string =>
  readFileSync(join(homedir(), ".mykey", "secrets", "probe", "read-token"), "utf8").trim();

async function view(name = "staging"): Promise<View> {
  const response = await fetch(`${PROBE}/v1/state/${name}`, {
    headers: { authorization: `Bearer ${readToken()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`probe state: HTTP ${String(response.status)}`);
  return (await response.json()) as View;
}

/** The first delivered row of `condition`/`kind` at or after `since`, polled every 15 s for `ms`. */
async function delivered(
  condition: string,
  kind: string,
  since: number,
  ms: number,
): Promise<Row | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await view().then(
      (current) => current.alerts,
      () => [] as Row[],
    );
    const row = rows
      .filter(
        (r) => r.condition === condition && r.kind === kind && r.at >= since && r.delivered === 1,
      )
      .sort((a, b) => a.at - b.at)[0];
    if (row !== undefined) return row;
    if (Date.now() > deadline) return undefined;
    await sleep(15_000);
  }
}

async function root(
  command: string,
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await sshExec(host, command, {
    sudo: true,
    timeoutMs: opts.timeoutMs ?? 120_000,
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
  });
  return expectSuccess(result, command.slice(0, 60)).stdout;
}

function record(line: string): void {
  if (!existsSync(EVIDENCE)) {
    writeFileSync(
      EVIDENCE,
      "# Alerts on staging (Run 6.4 Task C)\n\nOne line per drill, appended by `tests/staging/alerts.staging.test.ts` (times in seconds, the Worker's clock against the workstation's).\n\n",
    );
  }
  appendFileSync(EVIDENCE, `- ${new Date().toISOString()} ${line}\n`);
}

const seconds = (ms: number): number => Math.round(ms / 1000);

/**
 * One drill: announce, cause, wait for `opened` delivered, undo (always),
 * wait for `resolved` delivered, record the line.
 */
async function drill(
  condition: string,
  cause: string,
  start: () => Promise<void>,
  stop: () => Promise<void>,
  limits: { openMs: number; resolveMs: number },
): Promise<void> {
  // The previous drill's other alerts may still be resolving: wait for a clean start.
  let before = await view();
  for (let attempt = 0; attempt < 40 && Object.keys(before.state.open).length > 0; attempt += 1) {
    await sleep(15_000);
    before = await view();
  }
  expect(Object.keys(before.state.open), "staging must be clean before a drill").toEqual([]);
  await root(`logger -t mykey-drill "${condition}: start (${cause})"`);
  const since = Date.now() - 5_000;
  let opened: Row | undefined;
  let removedAt: number;
  try {
    await start();
    opened = await delivered(condition, "opened", since, limits.openMs);
  } finally {
    await stop();
    removedAt = Date.now();
    await root(`logger -t mykey-drill "${condition}: cause removed"`);
  }
  expect(opened, `${condition} opened and delivered`).toBeDefined();
  const resolved = await delivered(condition, "resolved", removedAt - 5_000, limits.resolveMs);
  expect(resolved, `${condition} resolved and delivered`).toBeDefined();
  record(
    `**${condition}**: opened and delivered ${String(seconds((opened?.at ?? 0) - since))} s after the cause (${cause}); resolved and delivered ${String(seconds((resolved?.at ?? 0) - removedAt))} s after it was removed`,
  );
}

const ON_TIME = { openMs: 600_000, resolveMs: 420_000 };

afterAll(async () => {
  // Every drill undoes its own cause; this removes anything a killed run left behind.
  await root(
    `rm -rf ${HOOKS} /var/lib/mykey/drill-filler /run/systemd/system/mykey-drill.service /run/systemd/system/mykey-audit-archive.service.d /run/systemd/system/mykey-heartbeat.service.d /var/lib/mykey/drill-bin; sed -i '/^MYKEY_BACKUP_EXPECTED=/d' /etc/mykey/host.env; systemctl daemon-reload; systemctl reset-failed 'mykey-*' || true; systemctl start mykey-heartbeat.timer`,
  ).catch(() => undefined);
});

describe("on demand (P-117)", () => {
  it("alert-test: the message is sent and its row is in the log", async () => {
    const since = Date.now() - 5_000;
    const run = spawnSync(process.execPath, ["scripts/probe.ts", "alert-test", "staging"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status, run.stderr.slice(-300)).toBe(0);
    const row = await delivered("test_alert", "test", since, 60_000);
    expect(row).toBeDefined();
    record(
      "**test_alert**: `probe.ts alert-test staging` sent `MyKey staging: test_alert`; its row is in the log, delivered",
    );
  }, 120_000);
});

describe("every condition, opened, delivered and resolved (P-116)", () => {
  it("certificate_expiring", async () => {
    const entry = [
      {
        name: "drill",
        notBefore: new Date(Date.now() - 85 * DAY).toISOString().replace(/\.[0-9]{3}Z$/, "Z"),
        notAfter: new Date(Date.now() + 5 * DAY).toISOString().replace(/\.[0-9]{3}Z$/, "Z"),
      },
    ];
    await drill(
      "certificate_expiring",
      "a 90-day certificate entry with 5 days left, through the drill hook",
      async () => {
        await root(
          `install -d -m 0755 ${HOOKS} && install -m 0644 /dev/stdin ${HOOKS}/certificates.extra.json`,
          { stdin: JSON.stringify(entry) },
        );
      },
      async () => {
        await root(`rm -f ${HOOKS}/certificates.extra.json`);
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("credential_expiring", async () => {
    const { cookie } = await stagingOwnerSession();
    const send = (method: string, path: string, body: unknown): Promise<PublicAnswer> =>
      publicRequest(method, path, { body, cookie, headers: { "idempotency-key": randomUUID() } });
    const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
      name: `s6-alerts-${randomBytes(3).toString("hex")}`,
    });
    expect(created.status, created.body.slice(0, 200)).toBe(201);
    const result = (
      JSON.parse(created.body) as {
        result: { projectId: string; developmentEnvironmentId: string };
      }
    ).result;
    const path = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments/${result.developmentEnvironmentId}`;
    record(
      `(credential_expiring uses project ${result.projectId}, environment ${result.developmentEnvironmentId})`,
    );
    // The environment is provisioned asynchronously.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const listed = await publicRequest("GET", `${path}/credentials`, { cookie });
      if (listed.status === 200) break;
      await sleep(5_000);
    }
    let credentialId = "";
    await drill(
      "credential_expiring",
      "a credential issued for six days",
      async () => {
        const issued = await send("POST", `${path}/credentials`, {
          name: "s6-expiring",
          ttlSeconds: 6 * 86_400,
        });
        expect(issued.status, issued.body.slice(0, 200)).toBe(201);
        const body = JSON.parse(issued.body) as {
          credential: { credentialId: string };
          token: string;
        };
        registerSecret(body.token);
        credentialId = body.credential.credentialId;
      },
      async () => {
        if (credentialId === "") return;
        const revoked = await send("POST", `${path}/credentials/${credentialId}/revoke`, {
          confirmed: true,
        });
        expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
      },
      ON_TIME,
    );
  }, 1_500_000);

  it("firewall_unloaded", async () => {
    await drill(
      "firewall_unloaded",
      "the drill flag; the ruleset stays loaded",
      async () => {
        await root(`install -d -m 0755 ${HOOKS} && touch ${HOOKS}/firewall-unloaded`);
      },
      async () => {
        await root(`rm -f ${HOOKS}/firewall-unloaded`);
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("unit_failed", async () => {
    await drill(
      "unit_failed",
      "mykey-drill.service exits 1",
      async () => {
        await root(
          "install -m 0644 /dev/stdin /run/systemd/system/mykey-drill.service && systemctl daemon-reload && (systemctl start mykey-drill.service || true)",
          {
            stdin:
              "[Unit]\nDescription=MyKey alert drill (Run 6.4)\n[Service]\nType=oneshot\nExecStart=/bin/false\n",
          },
        );
      },
      async () => {
        await root(
          "systemctl reset-failed mykey-drill.service || true; rm -f /run/systemd/system/mykey-drill.service; systemctl daemon-reload",
        );
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("audit_failing", async () => {
    const dropIn = "/run/systemd/system/mykey-audit-archive.service.d";
    await drill(
      "audit_failing",
      "the audit archive unit fails (a runtime drop-in)",
      async () => {
        await root(
          `install -d -m 0755 ${dropIn} && install -m 0644 /dev/stdin ${dropIn}/drill.conf && systemctl daemon-reload && (systemctl start mykey-audit-archive.service || true)`,
          {
            stdin: "[Service]\nExecStart=\nExecStart=/bin/false\n",
          },
        );
      },
      async () => {
        await root(
          `rm -rf ${dropIn}; systemctl daemon-reload; systemctl reset-failed mykey-audit-archive.service || true`,
        );
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("disk_low", async () => {
    await drill(
      "disk_low",
      "a file allocated until 3 GiB are left on the volumes' filesystem",
      async () => {
        await root(
          "avail=$(df -B1 --output=avail /var/lib/mykey | tail -n 1 | tr -d ' '); fallocate -l $((avail - 3221225472)) /var/lib/mykey/drill-filler",
        );
      },
      async () => {
        await root("rm -f /var/lib/mykey/drill-filler");
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("backup_stale", async () => {
    await drill(
      "backup_stale",
      "MYKEY_BACKUP_EXPECTED=yes and no eligible pair (drill hook)",
      async () => {
        await root(
          `sed -i '/^MYKEY_BACKUP_EXPECTED=/d' /etc/mykey/host.env && echo MYKEY_BACKUP_EXPECTED=yes >> /etc/mykey/host.env && install -d -m 0755 ${HOOKS} && echo none > ${HOOKS}/backup-newest.override`,
        );
      },
      async () => {
        await root(
          `sed -i '/^MYKEY_BACKUP_EXPECTED=/d' /etc/mykey/host.env; rm -f ${HOOKS}/backup-newest.override`,
        );
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("checks_unknown", async () => {
    const dropIn = "/run/systemd/system/mykey-heartbeat.service.d";
    await drill(
      "checks_unknown",
      "openssl shadowed in the heartbeat's PATH, so the certificates are unknown",
      async () => {
        await root(
          "install -d -m 0755 /var/lib/mykey/drill-bin && install -m 0755 /dev/stdin /var/lib/mykey/drill-bin/openssl",
          { stdin: "#!/bin/sh\nexit 1\n" },
        );
        await root(
          `install -d -m 0755 ${dropIn} && install -m 0644 /dev/stdin ${dropIn}/drill.conf && systemctl daemon-reload`,
          {
            stdin:
              "[Service]\nEnvironment=PATH=/var/lib/mykey/drill-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n",
          },
        );
      },
      async () => {
        await root(`rm -rf ${dropIn} /var/lib/mykey/drill-bin; systemctl daemon-reload`);
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("heartbeat_missing", async () => {
    await drill(
      "heartbeat_missing",
      "the heartbeat timer stopped",
      async () => {
        await root("systemctl stop mykey-heartbeat.timer");
      },
      async () => {
        await root(
          "systemctl start mykey-heartbeat.timer && systemctl start mykey-heartbeat.service",
        );
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("health_failing", async () => {
    const unit = `mykey-edge-back-${String(Math.floor(Date.now() / 1000))}`;
    await drill(
      "health_failing",
      "the edge stopped",
      async () => {
        await root(
          `systemd-run --quiet --collect --on-active=600 --unit=${unit} docker start mykey-edge-1 && docker stop mykey-edge-1 >/dev/null`,
          { timeoutMs: 60_000 },
        );
      },
      async () => {
        await root(
          `docker start mykey-edge-1 >/dev/null; systemctl stop ${unit}.timer 2>/dev/null || true`,
        );
      },
      ON_TIME,
    );
  }, 1_200_000);

  it("openbao_sealed", async () => {
    const staging: StagingStack = await connectStaging({ openbao: true });
    const bao = staging as unknown as Stack;
    try {
      await drill(
        "openbao_sealed",
        "OpenBao sealed through its API with the custody root token; unsealed by a restart (the KMS seal unseals at start)",
        async () => {
          const sealed = await baoFetch(bao, "/v1/sys/seal", {
            method: "POST",
            token: staging.bao.rootToken,
          });
          expect(sealed.status).toBe(204);
        },
        async () => {
          await root("docker restart mykey-openbao-1 >/dev/null", { timeoutMs: 180_000 });
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const status = await baoFetch(bao, "/v1/sys/seal-status", { token: "" }).catch(
              () => undefined,
            );
            if (
              status?.status === 200 &&
              ((await status.json()) as { sealed?: boolean }).sealed === false
            )
              return;
            await sleep(5_000);
          }
          throw new Error("OpenBao did not unseal within 5 minutes");
        },
        { openMs: 600_000, resolveMs: 600_000 },
      );
    } finally {
      await staging.close();
    }
  }, 2_400_000);

  it("kms_unreachable", async () => {
    let blockedAt = 0;
    await drill(
      "kms_unreachable",
      "the KMS cut off for 420 s while OpenBao runs",
      async () => {
        // The kernel lifts the block by itself after 420 s.
        await root("/opt/mykey/hosts/firewall/mykey-egress.sh block kms 420");
        blockedAt = Date.now();
      },
      async () => {
        // An early end of the block: reloading the table drops every block.
        if (blockedAt !== 0)
          await root("/opt/mykey/hosts/firewall/mykey-egress.sh apply >/dev/null");
      },
      { openMs: 420_000, resolveMs: 420_000 },
    );
  }, 1_800_000);

  it("operations_unresolved", async () => {
    // The drills of Sessions 4 and 5 that raise it are stale against Run 6.3's
    // rate limits (open issue, run-6.4.md): a synthetic uncertain operation
    // of an action no sweep knows, removed in finally, raises the same count.
    const staging: StagingStack = await connectStaging();
    const superuser: pg.Pool = createPool({
      ...staging.pg,
      user: "postgres",
      password: staging.pg.superuser.password,
    });
    const id = randomUUID();
    try {
      await drill(
        "operations_unresolved",
        "a synthetic uncertain operation (action drill.alert, no sweep touches it)",
        async () => {
          await superuser.query(
            `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
             VALUES ($1::uuid, 'operator', 'alert-drill', 'drill.alert', $1::text, $1::text, 'uncertain')`,
            [id],
          );
        },
        async () => {
          await superuser.query(
            "DELETE FROM app.operation WHERE id = $1 AND action = 'drill.alert'",
            [id],
          );
        },
        ON_TIME,
      );
    } finally {
      await superuser.end();
      await staging.close();
    }
  }, 1_500_000);

  it("capture_frozen", async () => {
    const staging: StagingStack = await connectStaging();
    const superuser: pg.Pool = createPool({
      ...staging.pg,
      user: "postgres",
      password: staging.pg.superuser.password,
    });
    try {
      await drill(
        "capture_frozen",
        "the control row held in draining (no product write meanwhile)",
        async () => {
          const held = await superuser.query(
            "UPDATE app.service_control SET capture_mode = 'draining', owner = 'alert-drill', updated_at = now() WHERE capture_mode = 'idle'",
          );
          expect(held.rowCount).toBe(1);
        },
        async () => {
          await superuser.query(
            "UPDATE app.service_control SET capture_mode = 'idle', owner = NULL, updated_at = now() WHERE owner = 'alert-drill'",
          );
        },
        { openMs: 1_080_000, resolveMs: 420_000 },
      );
    } finally {
      await superuser.end();
      await staging.close();
    }
  }, 2_000_000);
});

describe("outside the host (Task C step 2, AC-1.25)", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/probe.ts", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
    });
  /** The sink-test Worker's alert rows (its sink fails on purpose: delivered 0). */
  const rows = (): Row[] => {
    const run = cli("sinktest", "rows");
    if (run.status !== 0) return [];
    const last = run.stdout.trim().split("\n").at(-1) ?? "{}";
    return (JSON.parse(last) as { alerts?: Row[] }).alerts ?? [];
  };
  const opened = async (name: string, ms: number): Promise<Row | undefined> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const row = rows().find(
        (r) => r.host === name && r.condition === "health_failing" && r.kind === "opened",
      );
      if (row !== undefined || Date.now() > deadline) return row;
      await sleep(30_000);
    }
  };

  it("a name that does not resolve, a name not in the certificate, and staging with its API stopped each open health_failing", async () => {
    const unit = `mykey-api-back-${String(Math.floor(Date.now() / 1000))}`;
    expect(cli("drill-dns", "up").status).toBe(0);
    expect(cli("sinktest", "up", "--outside").status).toBe(0);
    const deployedAt = Date.now();
    let stoppedAt = 0;
    try {
      // A new cron trigger can take up to 15 minutes to start (Run 2.6).
      const nodns = await opened("nodns", 1_500_000);
      const badcert = await opened("badcert", 300_000);
      expect(nodns, "nodns").toBeDefined();
      expect(badcert, "badcert").toBeDefined();
      record(
        `**health_failing, outside**: a name that does not resolve opened ${String(seconds((nodns?.at ?? 0) - deployedAt))} s after the sink-test Worker was deployed; a name of our zone pointing at staging but not in its certificate opened ${String(seconds((badcert?.at ?? 0) - deployedAt))} s after (sink-test Worker, its sink fails on purpose)`,
      );
      await root(
        `systemd-run --quiet --collect --on-active=900 --unit=${unit} docker start mykey-api-1 && docker stop mykey-api-1 >/dev/null`,
        { timeoutMs: 60_000 },
      );
      stoppedAt = Date.now();
      const stopped = await opened("staging", 600_000);
      expect(stopped, "staging with the API stopped").toBeDefined();
      record(
        `**health_failing, outside**: staging with its API stopped opened ${String(seconds((stopped?.at ?? 0) - stoppedAt))} s after the API stopped (sink-test Worker)`,
      );
    } finally {
      if (stoppedAt !== 0)
        await root(
          `docker start mykey-api-1 >/dev/null; systemctl stop ${unit}.timer 2>/dev/null || true`,
        );
      cli("drill-dns", "down");
      cli("sinktest", "down");
    }
  }, 3_000_000);
});
