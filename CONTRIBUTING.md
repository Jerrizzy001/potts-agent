# Contributing

Use Node >=24.12, `npm ci`, `npm run typecheck`, and `npm test`. Run `npm run public:demo` for the portable entrypoint. Tests must use synthetic data, temporary homes, fake transports/providers, and no developer-specific files. Preserve any existing working-tree changes.

Keep runtime/configuration and all personal content outside the checkout. Use reserved example domains and fictional identities. Never attach live databases, agent transcripts, screenshots with account data, or secret-bearing diagnostic output to an issue or pull request.

Describe the user-visible behavior, relevant tests, and limits. New adapters need protocol, timeout, failure, identity, and uncertain-delivery tests. New claims need evidence. Do not add a provider-specific dependency or change the default permission model without documenting its data flow.

Before release, run checks on a fresh clone, review the source/history and exact archive for private content, verify documentation commands, and complete the appropriate user-owned live setup canary. Keep detailed privacy findings outside public artifacts.
