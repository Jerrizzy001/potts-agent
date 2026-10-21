# Extended runtime updates

These changes apply to the optional OpenClaw coordinator and workers. The portable bridge remains the default installation path and continues to use the agent you choose.

## Inspect before answering

`potts_environment_status` accepts a `project` name or path. It resolves one local directory or repository-name alias, reads a bounded README, package description, and recent commit subjects, and can read an ordinary source file using `file` and `fromLine`. Discovery covers immediate subdirectories of `~/Projects` and explicit `repoPath` entries in the runtime's `projects.json`. Register repositories elsewhere rather than changing the source to include a personal home path.

Ambiguous names return candidates. File reads reject traversal, hidden paths, symlinks, credential filenames, and non-text or oversized files. Git history inspection disables signature verification and external diff/text conversion. Returned content is untrusted evidence; reading a README does not verify its claims or run tests.

For a fresh verified owner opinion request with a project path on its own line, the prompt hook can attach evidence before model reasoning. It requires a matching run ID, message ID, or exact current message, rejects stale/internal requests, and rechecks admission after inspection. Hosts without the required current-turn metadata skip automatic preinspection; the explicit read tool remains available. Remote GitHub URLs are not treated as a local match solely because their repository basenames match.

The coordinator is instructed to answer the requested opinion, keep routine inspection silent, and avoid unsolicited drafts, publication disclaimers, repeated acknowledgements, or worker narration. These instructions guide behavior; they do not guarantee every model response will meet the preferred length or tone.

## Coordinator model selection

The extended model helper selects `openai/gpt-6.1-sol` for an **existing** `potts-coordinator`. It uses the per-agent `openclaw` runtime while preserving native worker routing, connection settings, tool restrictions, and memory configuration. It requires a compatible installed OpenClaw version and an already-authenticated provider supporting this model. It does not install or authenticate a provider.

Preview against your explicitly selected extended configuration:

```sh
OPENCLAW_CONFIG_PATH=/path/to/your/openclaw.json node scripts/coordinator/configure.ts
```

Review the private candidate, then repeat with `--apply` to validate, back up and atomically replace that configuration. `OPENCLAW_BIN` can select the installed CLI. This is separate from portable setup. The helper does not restart services, modify active session overrides, reset history, or send messages. Existing explicitly pinned sessions need a model change through your host's supported session controls before they follow the new selection.

## Existing reliability features retained

- Reminders use persisted state and check quiet hours at dispatch, including delayed/retried work.
- Task execution and report delivery have independent outcomes; interruption/resume needs matching task evidence.
- Reactions target a specific owner message and track duplicate/failure outcomes when supported by the transport.
- Memory keeps source-linked preferences and corrections distinct from tentative patterns, with bounded retrieval and forgetting.
- Messaging, computer, browser and external connections are reported separately.

Synthetic tests cover these boundaries. Real messaging, provider access, automatic hook correlation and OS capabilities must still be verified in the installation where they run. Worker completion currently relays a validated short report directly; comprehensive request amendment and suppression of obsolete worker results are not implemented by this update.
