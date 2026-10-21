# Operations

Use a dedicated runtime home outside the clone. Pass it explicitly to commands; the macOS default is `~/Library/Application Support/PottsPublic`.

## Foreground and background

`npm run public:run -- --home <path>` runs in the foreground; Ctrl-C stops it. The runtime lock prevents a second bridge from using the same home. If a process crashes, a stale lock is checked before reuse; do not delete a lock belonging to a live process.

`npm run public:service -- --home <path>` previews the macOS LaunchAgent. Add `--apply` to install/start it only after a successful foreground owner-message test. Its distinct label is `local.potts.public.bridge`.

The service uses absolute executable and repository paths. If you move the clone, regenerate the service. Launchd does not inherit your interactive shell's exported credentials or PATH. Prefer the agent's established local authentication store or a trusted wrapper that fetches its own credentials. Potts does not embed secret values into a plist. Verify the real agent and iMessage path again in service context.

The service runs in the logged-in user's session. Keep the Mac awake, online and signed in to Messages; this release does not promise operation after logout, during sleep, or without network.

## Pause and failure states

`/pause` stops normal request processing; `/resume` permits later requests. `/memory`, `/forget`, and `/status` remain available. Portable pause is not cancellation of an already running agent turn; messages are processed sequentially. Stop the foreground process or service to stop new bridge processing. Work already dispatched inside an external agent or its background tools can continue; inspect that agent's state before repeating work.

Each admitted message is reserved in the local ledger before processing. A failed, interrupted, or uncertain message is not automatically retried. This avoids duplicate effects at the cost of requiring a fresh request after a failure. No downtime history replay is performed.

A runtime binds to its first transport/owner/chat. Use a fresh home when changing any of those; the bridge refuses to reuse old memory for a different identity. Changing the selected agent for the same owner is allowed. A home used for the explicit demo cannot later become a live home. The zero-argument demo uses an automatically removed temporary home.

## Update

Stop the bridge, back up its private runtime, and update the source checkout without discarding local edits. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run public:demo`. Review release notes/config changes, run doctor, then restart and verify a new owner message. Do not copy a different user's runtime or merge private history into this repository.

## Back up and remove

Stop the bridge before copying its entire home so SQLite data/WAL and configuration remain consistent. Treat backups as private: they include memory and may contain selected identity/configuration. The portable home is separate from the extended daemon's backup commands.

Preview uninstall:

```sh
npm run public:service -- --home "$HOME/Library/Application Support/PottsPublic" --uninstall
```

Apply with `--uninstall --apply`. Uninstall removes the bridge service, not the runtime or another agent's services. Delete your chosen runtime separately only when you want to remove its local memory and ledger. Deleting it does not delete Messages history, cloud-agent records, or other backups.
