# Architecture

## Portable path

```
Verified direct iMessage
  -> imsg watch
  -> owner/chat/echo checks
  -> durable per-message ledger
  -> local learning context
  -> configured agent adapter
  -> metadata recheck
  -> imsg send to the same configured conversation
```

`src/portable` contains config validation, child-process boundaries, adapters, the bridge, and service installation. `scripts/public/cli.ts` is the public command entrypoint. It reuses the source-linked learning engine in `integrations/openclaw/potts-broker-plugin/lib/learning.ts`.

The bridge reserves message IDs before work, persists uncertainty, and never automatically replays a reserved request. It serializes work. Owner commands run outside the model. The adapter cannot set the reply destination. This is an application boundary, not an OS sandbox around a user-chosen executable.

## Extended runtime

`src/daemon` assembles policy, approvals, broker, SQLite, audit, scheduler, readers, optional writers, and capability status. The OpenClaw plugin provides tools and signed owner-intent ingress over local sockets. The agent proposes actions; the broker validates bound approvals before dispatching broker-managed effects. Separate worker agents may have their own tool authority, which must be configured explicitly.

Kept modules include memory/style, drafts, notifications/reminders, mail/OAuth, monitoring, isolated delegation, releases, support, voice/telephony, and backup/restore. Personal school workflows, operating records, and deployment targets are not distributed.

See [extended updates](EXTENDED-UPDATES.md) for bounded project inspection, current-turn grounding and the opt-in coordinator model helper.

## Extending safely

Use `config/*.example.json` and the JSON schema as starting points for a **new** extended home. Project registry starts empty; monitors and external effects are off. Do not connect a public clone to another installation's database. Optional modules require their own account, credentials, provider checks and capability verification.

The extended OpenClaw plugin is in `integrations/openclaw/potts-broker-plugin`. It requires the documented conversation hooks and `plugins.entries.potts-broker.hooks.allowConversationAccess: true` for learning. Owner channel, target, ingress key reference, daemon sockets, and coordinator identity must agree. The public setup path does not modify these settings automatically. Read the source and test with a separate profile; do not apply a tool-policy patch blindly to an existing agent.

Advanced profile patches can grant file, command, or computer access. They are optional developer configurations and do not inherit the portable bridge's limited reply surface. Review their concrete capability allowlists and provider/model settings before enabling. A prompt, reviewer model, or broker cannot sandbox unrelated tools an agent already possesses.

## Repository map

| Path | Purpose |
|---|---|
| `src/portable`, `scripts/public`, `examples` | Public setup and own-agent bridge |
| `src/policy`, `src/approvals`, `src/broker`, `src/audit` | Extended policy and execution boundaries |
| `src/memory`, `src/style` | Extended fact memory and writing-style tools |
| `src/daemon`, `src/jobs`, `src/notifications` | Background scheduling and owner updates |
| `src/connectors` | Optional accounts and message readers/writers |
| `src/delegation`, `src/workers`, `src/release` | Optional scoped work and release execution |
| `integrations/openclaw` | Advanced runtime adapter/plugin |
| `config`, `migrations`, `profile`, `deploy` | Generic schemas, storage, profiles and deployment utilities |
| `tests` | Synthetic fixtures, unit and end-to-end checks |
