// Structure of the authority matrix. The integration test proves each cell
// against real OpenBao; this file proves the matrix itself is complete and that
// every denial has a control (Review focus 4).
import {
  AUTHORITY_ACTIONS,
  AUTHORITY_MATRIX,
  IDENTITIES,
  ROOT_CONTROLS,
  cellColumn,
  cellKey,
  controlOf,
} from "@mykey/openbao";
import { describe, expect, it } from "vitest";

const PLACEHOLDERS = new Set([
  "{pid}",
  "{eid}",
  "{seed}",
  "{victim}",
  "{fresh}",
  "{accessor}",
  "{ns}",
  "{machinePolicy}",
  "{runtimePolicy}",
]);

/** Every allow, written out by hand from infra/openbao/policies/*.hcl (Doc 06 §5). */
const EXPECTED_ALLOWS = [
  ...["own", "other_environment"].flatMap((column) => [
    `runtime kv.write ${column}`,
    `runtime kv.read ${column}`,
    `runtime kv.read_version_1 ${column}`,
    `runtime kv.list_environment ${column}`,
    `runtime kv.soft_delete ${column}`,
    `runtime kv.undelete ${column}`,
    `runtime kv.read_metadata ${column}`,
    `issuer token.create_from_role ${column}`,
    `issuer token_role.read ${column}`,
    `issuer policy.read_machine ${column}`,
    `provisioner token_role.read ${column}`,
    `provisioner token_role.write ${column}`,
    `provisioner policy.read_machine ${column}`,
    `provisioner policy.write_machine ${column}`,
  ]),
  "runtime kv.list_project own",
  "runtime kv.list_projects own",
  "runtime token.lookup_self own",
  "runtime token.revoke_self own",
  "issuer token.lookup_accessor own",
  "issuer token.revoke_accessor own",
  "issuer token.revoke_self own",
  "provisioner token.revoke_self own",
  "machine kv.read own",
  "machine kv.read_version_1 own",
  "machine kv.list_environment own",
  "machine token.lookup_self own",
  "backup raft.snapshot root",
  // Self operations act on the caller's own token wherever the request is sent
  // (observed in Run 2.1, D-17): the same rows, not new rights.
  ...["other_organization", "other_organization_path", "root"].flatMap((column) => [
    `runtime token.lookup_self ${column}`,
    `machine token.lookup_self ${column}`,
    `runtime token.revoke_self ${column}`,
    `issuer token.revoke_self ${column}`,
    `provisioner token.revoke_self ${column}`,
  ]),
].sort();

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe("authority matrix structure", () => {
  it("every identity × action has an own cell", () => {
    expect(AUTHORITY_ACTIONS.length).toBeGreaterThanOrEqual(40);
    for (const identity of IDENTITIES) {
      for (const action of AUTHORITY_ACTIONS) {
        const own = AUTHORITY_MATRIX.filter(
          (cell) => cell.identity === identity && cell.action === action && cell.target === "own",
        );
        expect(own, `${identity} ${action}`).toHaveLength(1);
      }
    }
  });

  it("no two cells are equal", () => {
    const keys = AUTHORITY_MATRIX.map(cellKey);
    expect(new Set(keys).size).toBe(keys.length);
    const requests = AUTHORITY_MATRIX.map((cell) =>
      JSON.stringify([cell.identity, cell.target, cell.request]),
    );
    expect(new Set(requests).size).toBe(requests.length);
  });

  it("the allows are exactly the policy templates' rows", () => {
    const allows = AUTHORITY_MATRIX.filter((cell) => cell.expect === "allow").map(cellKey);
    expect(allows.sort()).toEqual(EXPECTED_ALLOWS);
  });

  it("every deny cell has an allow cell for the same request, or the root token", () => {
    let byIdentity = 0;
    for (const cell of AUTHORITY_MATRIX.filter((c) => c.expect === "deny")) {
      const control = controlOf(cell);
      if (control.by === "root") {
        // The root token never revokes itself: such a cell needs an identity control.
        expect(cell.action, cellKey(cell)).not.toBe("token.revoke_self");
        continue;
      }
      byIdentity += 1;
      const allow = AUTHORITY_MATRIX.find(
        (other) =>
          other.identity === control.by &&
          other.action === cell.action &&
          cellColumn(other) === cellColumn(cell),
      );
      expect(allow?.expect, cellKey(cell)).toBe("allow");
      expect(allow?.request, cellKey(cell)).toEqual(cell.request);
    }
    expect(byIdentity).toBeGreaterThan(0);
  });

  it("a denial other than 403 states its status and reason", () => {
    for (const cell of AUTHORITY_MATRIX) {
      if (cell.expectStatus === undefined) continue;
      expect(cell.expect, cellKey(cell)).toBe("deny");
      expect(cell.expectStatus, cellKey(cell)).not.toBe(403);
      expect([200, 204], cellKey(cell)).not.toContain(cell.expectStatus);
      expect(cell.reason?.length ?? 0, cellKey(cell)).toBeGreaterThan(20);
    }
    expect(AUTHORITY_MATRIX.some((cell) => cell.expectStatus === 400)).toBe(true);
  });

  it("every root control names a request no identity may make", () => {
    for (const control of ROOT_CONTROLS) {
      const cells = AUTHORITY_MATRIX.filter(
        (cell) => cell.action === control.action && cellColumn(cell) === control.column,
      );
      const label = `${control.action} ${control.column}`;
      expect(cells.length, label).toBe(IDENTITIES.length);
      expect(
        cells.every((cell) => cell.expect === "deny"),
        label,
      ).toBe(true);
      expect(control.reason.length, label).toBeGreaterThan(20);
    }
  });

  it("a control that does not succeed is only one that OpenBao answers before policy", () => {
    for (const cell of AUTHORITY_MATRIX.filter((c) => c.expect === "deny")) {
      const control = controlOf(cell);
      if (control.by !== "root" || control.control === undefined) continue;
      const { status, mintedToken, action } = control.control;
      if (status === 200 || status === 204) continue;
      // A non-2xx control is accepted only where every caller gets the same pre-policy answer,
      // or where the endpoint is disabled for everyone (raw).
      expect(
        cell.expectStatus === status || action === "raw.read",
        `${cellKey(cell)} control ${status}`,
      ).toBe(true);
      expect(mintedToken, cellKey(cell)).toBeUndefined();
    }
    // renew-self has a control that succeeds: a renewable token renewing itself.
    const renew = ROOT_CONTROLS.filter((control) => control.action === "token.renew_self");
    expect(renew).toHaveLength(4);
    for (const control of renew) {
      expect(control).toMatchObject({ status: 200, mintedToken: true });
    }
  });

  it("requests use only the documented placeholders", () => {
    for (const cell of AUTHORITY_MATRIX) {
      for (const text of [cell.request.path, ...strings(cell.request.body)]) {
        for (const placeholder of text.match(/\{[A-Za-z]+\}/g) ?? []) {
          expect(PLACEHOLDERS, `${cellKey(cell)} ${placeholder}`).toContain(placeholder);
        }
      }
      expect(cell.request.path.startsWith("/"), cellKey(cell)).toBe(false);
      if (cell.target === "other_environment") expect(cell.request.path).toContain("{eid}");
    }
  });
});
