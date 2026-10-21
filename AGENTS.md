# Agent instructions

If the user supplied this repository and said they want Potts, read `docs/AGENT-SETUP.md` and perform the installation workflow. Start with the offline demo. Do not stop at summarizing the README when setup was requested.

## Preserve the user's system

- Work in this clone and a new runtime home outside Git. Never copy a previous user's runtime, memory, credentials, browser profile, or Messages database into the repository.
- Never overwrite an existing runtime/config or reconfigure an existing agent silently. The portable bridge has its own service label. Existing OpenClaw services and profiles are separate.
- Account authentication and operating-system permission dialogs belong to the user. Explain the exact next click when needed; do not collect passwords or tokens in chat.
- The demo must not read real Messages data, contact a model, or send a message. Live connectivity tests must use the user's selected direct conversation.
- Do not enable SIP-dependent private APIs for basic messaging. Do not install the extended profiles or migration tools as part of the portable quickstart.

## Completion evidence

Run typecheck and demo, configure the chosen agent, run doctor, and verify a real owner message/reply before describing iMessage as connected. Verify one saved preference survives a restart and can be forgotten. Separate local fixture checks, live agent checks, Messages permission checks, send acceptance, and recipient confirmation. Mark blockers explicitly; never invent success.

## Development

Use Node >=24.12 and `npm ci`. Tests use temporary homes and fake transports. Run `npm run typecheck`, relevant tests, then `npm test` before a release. Do not turn on `POTTS_LIVE_SMOKE` in CI. No test may access the developer's live account or operating specification. Keep third-party input untrusted and every side-effect boundary explicit. Keep privacy review reports containing personal findings outside the repository.
