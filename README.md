# Potts

**Your personal agent. One text away.**

Hi, I built **Potts**, an always-on personal agent that lives on your Mac, remembers the preferences you share, and is just an iMessage away.

The idea is simple: you should be able to text your assistant, tell it what matters, and come back later without explaining those preferences all over again. Start with a conversation. Connect more of your world when you're ready.

Potts brings together a familiar messaging app, an AI agent you choose, and memory you can actually look at and manage. With its optional integrations, it can remind you about things, surface important emails, keep an eye on your websites, and hand off work to specialist agents.

I'm open-sourcing it so you can run your own, make it yours, and help shape what comes next.

[Get started](#try-potts) · [Explore the features](#give-potts-more-to-do) · [Read the docs](#go-deeper) · [Contribute](CONTRIBUTING.md)

## Start with a conversation

The core setup gives you a dedicated iMessage conversation with your chosen agent and persistent memory on your Mac.

- **Text your assistant.** Reach it through a dedicated one-to-one conversation in Messages. Potts checks the conversation and sender before passing a request to your agent.
- **Tell it what to remember.** “Remember that I prefer short, direct replies.” Explicit preferences become saved notes that can inform later conversations, including after a restart.
- **See what it remembers.** Review saved sources with `/memory`, remove one with `/forget <sourceId>`, and check or pause Potts with `/status`, `/pause`, and `/resume`.
- **Choose the agent behind it.** Connect an existing OpenClaw agent or another compatible agent using the connection guide. Your chosen agent supplies the reasoning and any additional tools.

Potts can run in the background while your Mac is awake, online, and signed in to Messages. That's what “always on” means here; it won't keep working through sleep or logout.

## Give Potts more to do

The repository also includes an **optional advanced setup** with the capabilities below. Each needs its own configuration, permissions, and connection checks. Installing the basic setup doesn't switch them on.

- **Remember the little things for you.** Set one-time or recurring reminders, change them, or cancel them. Scheduled reminders are saved across restarts and respect configured quiet hours.
- **Bring you up to speed.** Schedule morning, evening, or night briefings that pull together connected information such as important mail, website status, completed work, unfinished tasks, and requests waiting for your approval.
- **Help with your inbox.** Connect Gmail or Outlook to read and categorize incoming mail, highlight interviews or business opportunities, and prepare replies. Personal emails and messages sent through Potts's approval system need your approval of the exact content and recipients.
- **Help your drafts sound like you.** Build separate casual and professional writing guides from your own messages, then use them to prepare drafts. Review examples and give feedback on the wording.
- **Find that conversation.** Search past iMessage and SMS text on your Mac when you've connected and permitted access to that history.
- **Turn a conversation into something useful.** Save notes, documents, scripts, and drafts as local files. With the matching media tools, send files, screenshots, short screen recordings, and spoken replies back to your own chat. Message reactions are available where the messaging service supports them.
- **Keep an eye on your websites.** Watch for outages, slow responses, and failing page checks. Track recovery, group repeated alerts, and distinguish a website problem from your Mac losing its connection.
- **Bring in help for bigger jobs.** Hand specific coding tasks to Claude Code or general research, planning, and other work to a configured specialist agent. Inspect local projects, follow progress, and request interruption or resumption of supported jobs. Browser and computer actions depend on the worker's own tools and permissions.
- **Prepare a fix for review.** The advanced coding workflow can work in a separate copy of a project you've connected and check the result. Its release workflow runs the checks you've set up and asks you to approve the exact change before merging or deploying it.
- **Help with customer support.** Draft replies using an approved knowledge base. Configured support channels can answer eligible routine questions automatically, while sensitive or uncertain requests go to you for review.
- **Use voice when it helps.** Optional phone integrations support voice conversations, configured alert calls to you, and calls to other people after your approval. These require a separate calling provider and setup.

The advanced setup also adds corrections and task outcomes to its memory tools, along with action history, connection status, backup and restore, and controls for pausing individual integrations.

See [capabilities and verification](docs/CAPABILITIES.md) for the exact boundaries and [architecture](docs/ARCHITECTURE.md) for the advanced setup.

## Personal means you have a say

**You can inspect the memory.** Potts shows where saved preferences came from and keeps what you've told it separate from what it has inferred. Its learning comes from using your feedback as context in future conversations. It doesn't retrain itself or rewrite its own code.

**You choose what to connect.** The basic setup doesn't automatically import your inbox, browser, or folders. Optional connections need separate setup. The advanced approval system governs the actions routed through it; permissions you give an outside agent still matter.

**Your memory lives on your Mac.** If you choose a cloud agent, your request and selected memory context go to that provider. iMessage uses Apple's service. Forgetting something in Potts removes it from Potts's local memory, not from Messages or another provider's records. [More about privacy](docs/PRIVACY.md).

## Try Potts

Potts is an early release. **The basic iMessage setup is the supported starting point.** The advanced integrations are included for people who want to configure and extend them; they need additional setup before you can use them.

### Let your coding agent help

Give this to a coding agent that can work on your Mac:

> Set up https://github.com/Jerrizzy001/potts-agent for me. Read AGENTS.md and docs/AGENT-SETUP.md first. Run the offline demo and checks, then help me connect my own agent and a dedicated iMessage conversation. Preserve my existing agents and data. Ask me to complete account sign-in and macOS permission prompts. Verify each setup step and tell me precisely which parts are working.

You handle account sign-in and Mac permission prompts. Your agent can help with the installation and configuration.

### Take a look without connecting accounts

The demo saves a sample preference, restarts the memory store, and recalls it in a later reply. It uses made-up messages and a demo agent, so no Apple account, AI account, or API key is needed. It doesn't send real messages.

<details>
<summary>Run the demo yourself</summary>

Requires Node **24.12 or newer** and Git.

```sh
git clone https://github.com/Jerrizzy001/potts-agent.git
cd potts-agent
npm ci
npm run typecheck
npm run public:demo
```

For real iMessage use, follow the [setup guide](docs/AGENT-SETUP.md) and [iMessage requirements](docs/IMESSAGE.md). The live bridge uses a dedicated direct conversation, ignores self-authored messages, and doesn't replay messages missed while it was stopped. Test your own connection before relying on it.

</details>

## Make it yours

Potts is available under the [MIT license](LICENSE). You're welcome to use it, change it, and build on it.

Try the demo. Share an idea. Report a bug. Improve the docs. Add a connection you wish existed. The [contributing guide](CONTRIBUTING.md) is a good place to start.

If you'd like a personal agent that's one text away, give Potts a star and help shape where it goes next.

## Go deeper

- [Agent-led setup](docs/AGENT-SETUP.md)
- [Connect your own agent](docs/AGENT-ADAPTERS.md)
- [iMessage requirements and troubleshooting](docs/IMESSAGE.md)
- [Memory and learning from feedback](docs/MEMORY.md)
- [Privacy and data flow](docs/PRIVACY.md)
- [Operations, updates, and uninstall](docs/OPERATIONS.md)
- [Capabilities and verification](docs/CAPABILITIES.md)
- [Architecture and advanced integrations](docs/ARCHITECTURE.md)
- [Advanced coordinator updates](docs/EXTENDED-UPDATES.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
