# Capabilities and verification

The portable bridge is the first-release setup path. The repository also retains the larger Potts daemon and OpenClaw plugin for advanced configurations. Their features do not become active merely by installing the bridge.

| Area | Implementation and boundary |
|---|---|
| Own-agent connection | Command JSON protocol and existing OpenClaw CLI agent; provider authentication remains the user's responsibility |
| iMessage | Exact owner/direct-chat checks; recent imsg metadata required; no same-account echo, groups, automatic retry, or downtime replay |
| Learning | Source-linked explicit notes, bounded context, review, inspect/forget; no weight training or self-modifying code |
| Background operation | Separate macOS LaunchAgent while user is logged in and machine/network available |
| Extended daemon | SQLite store, broker, content-bound approvals, audit ledger, scheduler, status, backups |
| Extended integrations | Optional mail, monitoring, reminders, briefings, delegation, releases, support and telephony; disabled/unconnected until configured |
| Computer/browser control | Only if supplied and permitted in the chosen external agent; portable Potts does not install desktop control |
| Advanced iMessage reactions/effects | Not part of the portable bridge; availability depends on external transport/OS capabilities |

## Automated proof

`npm run public:demo` uses synthetic data with real persisted/reopened learning storage. `npm run test:portable` exercises the actual CLI and fake transport executables. `npm run test:e2e` exercises the extended daemon and real local sockets with fake provider/Keychain/network implementations. `npm test` and `npm run typecheck` cover the source release.

These checks do not read your Messages database, authenticate your provider, test Apple's permissions, or establish real delivery. The documented live canary must be completed on each user's machine. No live-account compatibility claim should be inferred from a mocked transport test.

## Compatibility

Node >=24.12 is required. Live portable messaging requires macOS 14+ and an imsg version with the documented direct-chat metadata and watch/send commands; startup refuses missing/inconsistent fields. OpenClaw CLI and plugin interfaces were source-reviewed against the public npm `2026.10.5` package. This is interface evidence, not a full live-account certification. Test provider and OS upgrades in your environment before relying on them.

## Meaning of recursive learning

The learning loop repeatedly uses owner feedback as future context. Explicit notes and tentative patterns remain distinct. Do not describe this as recursive model training, autonomous software improvement, perfect recall, or automatic knowledge of every file/account.
