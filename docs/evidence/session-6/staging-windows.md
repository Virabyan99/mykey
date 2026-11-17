# Staging windows (Session 6)

Times when staging does not serve normally because a drill holds it. Written before the drill starts.

| Date (UTC)                       | Window       | Drill                                                                                         | What a caller sees                                                      |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 16 Nov 2026, from about 21:00    | about 20 min | Run 6.4 `openbao_sealed` / `kms_unreachable`: the KMS cut off for 420 s and OpenBao restarted | `/health` 503 and every secret route 503 while OpenBao is sealed        |
| 16 Nov 2026, after the KMS drill | about 15 min | Run 6.4 `capture_frozen`: the capture control row held in `draining`                          | secret writes and credential issuance answer `503 busy`; reads continue |
