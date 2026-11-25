# The first real application on production

**Owner-reported, 25 Nov 2026.** After PR #24 (Session 10) was merged, the owner built a project, connected it to production MyKey through a machine credential and the CLI, and reported: "I built a project and connected it to mykey, and it is working fine".

This closes the last item of D-74's hardening list (D-79: connect a real application, giving the agent `llms.txt`). It meets the condition that Gate F (D-74) left open, that no application ran yet.

## What this record is, and is not

- It is the owner's word. No agent ran the application, read production or checked the connection.
- It holds no production id, name, secret name or value, and not the owner's address.
- Not recorded: which machine runs the application, which coding agent connected it, whether it followed `llms.txt`, and whether the `.env` files were deleted (the guide's `remove-dotenv`).
- The machine's reads will show in the weekly field records (`host.ts prod field-pull`, `field-report.ts prod --week <n>`) as counts by credential label, from week 2 (29 Nov 2026).

## What follows from it

- The real-use clock stays at 22 Nov 2026, 14:27:41 UTC (`clock.json`); W-2 on 20 Dec 2026 reports on the use from here.
- The application's machine token lives at most 30 days, as chosen at issue: the owner rotates it before then with the one-command step (`replace-token`), then restarts the application.
