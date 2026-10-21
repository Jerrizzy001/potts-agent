# Memory and recursive feedback

“Recursive learning” in Potts means a repeated feedback loop: verified owner input informs stored context; that context informs a later response; further input or corrections refine what is used next. It is memory-based adaptation, not model-weight training, autonomous code rewriting, or a guarantee that every response improves.

## What is stored

The learning engine stores admitted owner requests and source-linked notes in local SQLite, and writes readable Markdown views. Explicit “Remember that …” preferences can be materialized from their exact source. Extended tools can save corrections, preferences, aliases and tentative patterns; patterns cannot override explicit notes. Task-specific instructions should not become enduring preferences.

The extended runtime can also record worker outcomes and review them. Execution status, model-reported success, and message delivery are separate. Portable mode does not automatically gain the extended worker or reminder integrations.

## Retrieval and review

Relevant context and standing explicit notes are bounded before they reach the agent. Daily review rebuilds local views; it does not invent facts to satisfy a quota. The portable bridge uses a dedicated knowledge directory, avoiding automatic discovery across Documents or your home folder. In extended mode, the learning engine can read Markdown beneath the parent of `learningDirectory` (bounded depth, file count and bytes). Choose that parent deliberately.

## Inspect and forget

In the configured portable conversation, `/memory` exposes saved sources and `/forget <sourceId>` removes an identified source from the learning store and regenerated views. `/pause`, `/resume`, and `/status` are owner commands handled before the agent. Forgotten explicit wording is guarded against automatic reintroduction from the same evidence.

Forgetting is local application deletion, not secure erasure of disk blocks. It does not erase the original Apple conversation, another agent's history, model-provider records, screenshots, or independent backups. Stop the process before removing or backing up a whole runtime directory. Do not restore older copies blindly after a deletion request.

## Sensitive input and retention

Credential-like inputs are filtered from learning, but pattern detection is not a guarantee. Do not send passwords, API tokens, recovery codes, or secrets to the assistant. The configured agent still receives the current request; local memory filtering does not prevent provider exposure.

Portable learning persists until explicitly forgotten or the runtime is removed. There is no automatic portable retention policy in this release. The extended daemon has separate configurable retention and tombstone handling; its policy does not automatically govern the portable learning database. See [privacy](PRIVACY.md).
