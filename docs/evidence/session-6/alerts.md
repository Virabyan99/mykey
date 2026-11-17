# Alerts on staging (Run 6.4 Task C)

One line per drill, appended by `tests/staging/alerts.staging.test.ts` (times in seconds, the Worker's clock against the workstation's).

- 2026-11-16T19:56:08.623Z **test_alert**: `probe.ts alert-test staging` sent `MyKey staging: test_alert`; its row is in the log, delivered
- 2026-11-16T19:58:29.983Z **certificate_expiring**: opened and delivered 80 s after the cause (a 90-day certificate entry with 5 days left, through the drill hook); resolved and delivered 48 s after it was removed
- 2026-11-16T19:58:53.135Z (credential_expiring uses project f375fd3d-02bb-4ea8-b6a5-d4145fe047d9, environment 346e80f8-615c-4527-925a-3dcf0d025bc9)
- 2026-11-16T20:00:36.778Z **credential_expiring**: opened and delivered 34 s after the cause (a credential issued for six days); resolved and delivered 56 s after it was removed
- 2026-11-16T20:06:39.364Z **firewall_unloaded**: opened and delivered 231 s after the cause (the drill flag; the ruleset stays loaded); resolved and delivered 102 s after it was removed
- 2026-11-16T20:12:39.285Z **unit_failed**: opened and delivered 289 s after the cause (mykey-drill.service exits 1); resolved and delivered 53 s after it was removed
- 2026-11-16T20:18:33.709Z **audit_failing**: opened and delivered 265 s after the cause (the audit archive unit fails (a runtime drop-in)); resolved and delivered 44 s after it was removed
- 2026-11-16T20:25:34.238Z **disk_low**: opened and delivered 294 s after the cause (a file allocated until 3 GiB are left on the volumes' filesystem); resolved and delivered 105 s after it was removed
- 2026-11-16T20:27:36.120Z **backup_stale**: opened and delivered 54 s after the cause (MYKEY_BACKUP_EXPECTED=yes and no eligible pair (drill hook)); resolved and delivered 56 s after it was removed
- 2026-11-16T20:44:30.366Z **checks_unknown**: opened and delivered 282 s after the cause (openssl shadowed in the heartbeat's PATH, so the certificates are unknown); resolved and delivered 47 s after it was removed
- 2026-11-16T20:48:42.936Z **heartbeat_missing**: opened and delivered 177 s after the cause (the heartbeat timer stopped); resolved and delivered 50 s after it was removed
- 2026-11-16T20:53:37.186Z **health_failing**: opened and delivered 225 s after the cause (the edge stopped); resolved and delivered 39 s after it was removed
- 2026-11-16T21:09:32.199Z **openbao_sealed**: opened and delivered 270 s after the cause (OpenBao sealed through its API with the custody root token; unsealed by a restart (the KMS seal unseals at start)); resolved and delivered 45 s after it was removed
- 2026-11-16T21:15:43.164Z **kms_unreachable**: opened and delivered 296 s after the cause (the KMS cut off for 420 s while OpenBao runs); resolved and delivered 50 s after it was removed
- 2026-11-16T21:28:28.324Z **capture_frozen**: opened and delivered 634 s after the cause (the control row held in draining (no product write meanwhile)); resolved and delivered 111 s after it was removed
- 2026-11-16T20:58:28Z (finding) The first attempt at `openbao_sealed` cut the KMS off and restarted OpenBao: OpenBao's listener stays silent while it waits for the KMS at start, so the host reported `sealed: null`. The probe opened and delivered `checks_unknown` and `kms_unreachable` (20:58:28 UTC), not `openbao_sealed`; unknown is not healthy (D-50). Both resolved by themselves once the KMS was back.
- 2026-11-16T21:33:00Z **review_open**: the Session 3 drill run again as it is (`provisioning.staging.test.ts -t AC-1.09`, a machine policy removed with the root token, 1/1): opened and delivered 21:31:26 UTC, resolved and delivered 21:32:26 UTC (the probe's alert log)
- 2026-11-16T21:50:37.967Z **operations_unresolved**: opened and delivered 49 s after the cause (a synthetic uncertain operation (action drill.alert, no sweep touches it)); resolved and delivered 54 s after it was removed
- 2026-11-16T22:00:22.119Z **health_failing, outside**: a name that does not resolve opened 506 s after the sink-test Worker was deployed; a name of our zone pointing at staging but not in its certificate opened 506 s after (sink-test Worker, its sink fails on purpose)
- 2026-11-17T08:29:32.148Z **health_failing, outside**: a name that does not resolve opened 612 s after the sink-test Worker was deployed; a name of our zone pointing at staging but not in its certificate opened 612 s after (sink-test Worker, its sink fails on purpose)
- 2026-11-17T08:33:19.003Z **health_failing, outside**: staging with its API stopped opened 213 s after the API stopped (sink-test Worker)
