# Agent-led setup

This is an executable runbook for a coding agent with terminal access. Use the portable bridge first. Keep the current user's other agents and data intact.

## 1. Establish the environment

Check `node --version`, `npm --version`, Git, and the operating system. Node >=24.12 is required. Live iMessage requires macOS 14+, Messages signed in, and the public `imsg` CLI. Linux can run the offline demo/tests but cannot host live iMessage sending.

Clone this repository into a new directory if it is not already present. Inspect existing work before updating a clone. Run:

```sh
npm ci
npm run typecheck
npm run public:demo
```

A passing demo proves a synthetic bridge/memory roundtrip only. Do not say the user's account is connected yet.

## 2. Create separate runtime storage

Choose a new directory outside the checkout. Example on macOS:

```sh
npm run public:setup -- --home "$HOME/Library/Application Support/PottsPublic"
```

Setup creates a demo configuration and refuses an existing destination. Read the generated configuration before editing it. Keep this home unused until its live transport/owner/chat are chosen. Use the zero-argument demo from step 1; running the demo with this explicit home permanently binds it to demo mode. Never reuse the private runtime of another Potts installation. Use the same `--home` on every following command.

## 3. Connect the user's agent

Ask which existing agent they want to use if it cannot be established from their instruction. See [the adapter contract](AGENT-ADAPTERS.md). Use either an explicitly configured OpenClaw agent or a command implementing the JSON protocol. Keep credentials in that agent's own authentication mechanism. Do not put credentials in config, argv, examples, or this repository.

An OpenClaw connection selects an existing agent ID, executable path, and optional profile. It does not overwrite OpenClaw's configuration or force a provider/model. A custom command receives one JSON request on stdin and returns one JSON response. Confirm the executable exists and that the user trusts its capabilities.

## 4. Prepare the iMessage conversation

Read [iMessage setup](IMESSAGE.md). Install `imsg` from its official distribution if needed. The Mac's Messages account must be reachable from the owner's separate account/number. Self-chat is intentionally unsupported by the portable bridge.

Have the owner send a fresh message to the agent account. Inspect only the selected conversation to get its chat ID, direct-chat membership, and exact sender handle. Configure the bridge with that chat ID and sender. Do not guess identity from a contact's display name or choose a group chat.

The user must grant Full Disk Access and Automation → Messages to the relevant launch context. Do not disable SIP or use advanced private APIs. Do not publish or paste message history into issue reports.

## 5. Doctor and foreground verification

```sh
npm run public:doctor -- --home "$HOME/Library/Application Support/PottsPublic"
npm run public:run -- --home "$HOME/Library/Application Support/PottsPublic"
```

Read doctor's actual checks: configuration validation and available executables do not prove provider authentication, Apple permissions, or delivery. With the foreground process running, have the owner send a new message in the configured conversation. Check that the agent replies there, ignores other senders, and does not reply to itself.

Send an explicit preference such as “Remember that I prefer concise explanations.” Ask a relevant follow-up. Use `/memory` to inspect the saved source. Restart the foreground bridge and confirm recall, then `/forget <sourceId>` and confirm it no longer appears. Confirm the reply on the receiving device; CLI acceptance alone is not recipient delivery.

Stop the foreground process before installing the background service. Do not run two copies against the same home.

## 6. Background service

```sh
npm run public:service -- --home "$HOME/Library/Application Support/PottsPublic"
npm run public:service -- --home "$HOME/Library/Application Support/PottsPublic" --apply
```

The first command previews the service. Inspect executable, working directory, home, and log paths before applying. The service label is `local.potts.public.bridge`. Verify the owner message/reply again in the service context; macOS permission grants can differ from the interactive terminal. Keep the Mac awake and online while using Potts.

## Completion report

Report separately: offline demo, selected agent, owner conversation, permission state, live reply confirmation, memory/restart/forget, and background service. If any step cannot be completed, give the exact next action and mark that portion unverified. Do not describe optional mail, reminders, releases, voice, or the extended plugin as configured by this quickstart.
