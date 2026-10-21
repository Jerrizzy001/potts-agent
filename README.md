# Potts

**A persistent personal agent on your Mac. Talk through iMessage. Bring your own agent. Build memory from your input.**

Potts connects a private owner conversation to an agent you choose and a local, inspectable memory. Explicit preferences and corrections become source-linked notes that inform later turns. This recursive feedback loop helps the assistant adapt over time without retraining model weights or granting itself new permissions.

## Give this repository to your agent

Copy this into a coding agent that can use your Mac's terminal:

> Set up https://github.com/Jerrizzy001/potts-agent for me. Read AGENTS.md and docs/AGENT-SETUP.md first. Run the offline demo and checks, then help me connect my own agent and a dedicated iMessage conversation. Preserve my existing agents and data. Ask me to complete account sign-in and macOS permission prompts. Verify each setup step and tell me precisely which parts are working.

The agent can perform installation and configuration. You still control account sign-in, your agent provider, and macOS permissions. Pasting a link does not grant those permissions automatically.

## Try it without accounts

Requires Node **24.12 or newer** and Git. The demo works without Apple Messages, a provider account, or API credentials.

```sh
git clone https://github.com/Jerrizzy001/potts-agent.git
cd potts-agent
npm ci
npm run typecheck
npm run public:demo
```

The demo uses synthetic messages and a deterministic agent. It exercises real local memory and the bridge; it does not send a real iMessage or call a model. See [setup](docs/AGENT-SETUP.md) to connect a real agent.

## What you get

| Capability | Portable quickstart | Extended runtime |
|---|---|---|
| Bring your own agent | JSON-over-stdio adapter or OpenClaw CLI | OpenClaw plugin and worker delegation |
| Owner-only iMessage conversation | Direct-chat and exact-sender checks | Channel-bound owner commands and approvals |
| Memory from your input | Explicit preferences, source-linked recall, review, forget | Corrections, patterns, task outcomes, additional memory tools |
| Persistent background process | Separate macOS LaunchAgent | Daemon, scheduler, queues, audit ledger |
| Pause and inspect | Local owner commands | Owner controls, capability status, action history |
| Reminders, briefings, mail, website monitoring | Not part of portable mode | Optional; configure and verify separately |
| Coding workers, releases, voice | Your connected agent's capabilities | Optional advanced integrations; disabled by default |

**Portable mode is the supported starting path.** The extended implementation is included for developers; an integration's source and passing fixture tests do not mean your account is connected. See [capabilities](docs/CAPABILITIES.md).

## Learning that you can inspect

Verified input → source-linked memory → relevant context → next response → new input or correction.

Potts keeps explicit notes separate from tentative patterns. Local SQLite and Markdown make saved knowledge inspectable. The learning loop does not fine-tune weights, rewrite its own code, or turn remembered text into approval. See [memory](docs/MEMORY.md).

## Local ownership, clear boundaries

Runtime data lives outside the Git checkout. No author's accounts, memories, message history, or personal project configuration are included. A connected cloud agent receives the request and selected memory context; a local agent can keep inference local. iMessage itself uses Apple's service. An agent command is trusted software running with your user permissions, not a sandbox. See [privacy](docs/PRIVACY.md).

The Mac must be awake, online and signed in to Messages for live operation. Portable mode deliberately ignores self-authored messages and uses a dedicated direct conversation. It does not replay messages missed while stopped. A successful send command is not proof the recipient read or received the message.

## Documentation

- [Agent-led setup](docs/AGENT-SETUP.md)
- [Connect your own agent](docs/AGENT-ADAPTERS.md)
- [iMessage requirements and troubleshooting](docs/IMESSAGE.md)
- [Memory and recursive feedback](docs/MEMORY.md)
- [Privacy and data flow](docs/PRIVACY.md)
- [Operations, updates, and uninstall](docs/OPERATIONS.md)
- [Capabilities and verification](docs/CAPABILITIES.md)
- [Architecture and extended integrations](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
