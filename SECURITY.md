# Security

Report vulnerabilities through GitHub's private vulnerability reporting for this repository when available. Do not include secrets, message history, account identifiers, or private databases in public issues. If private reporting is unavailable, open an issue requesting a private reporting channel without disclosing exploit details or private data.

The portable bridge checks one configured owner and direct conversation, validates agent responses, and suppresses automatic replay after uncertain outcomes. These controls do not sandbox a user-chosen agent executable. Configure that agent's tools separately.

Memory is context, not authorization. Prompt injection can still affect an external agent; retrieved content must not authorize actions. Secret filtering is best-effort and does not make it safe to put passwords into messages.

If a credential is exposed, revoke or rotate it with its provider. Deleting a file or Git commit does not invalidate credentials or remove all existing copies.
