# Privacy and data flow

## Portable path

1. `imsg` reads the local Messages database with macOS permission.
2. Potts admits only the configured direct chat and exact owner sender; outgoing/self-authored and group messages are rejected.
3. The local learning engine records admitted input and selects bounded context.
4. The configured agent receives the current request and selected context.
5. Potts sends the returned text to the configured conversation and records the send outcome.

The Git repository contains software and synthetic examples. Runtime homes, message databases, learned notes, job records, credentials, and operational logs belong outside Git.

## Local versus cloud

The bridge and learning store run locally. If your agent calls a cloud provider, that provider receives the request/context you send it. iMessage uses Apple's infrastructure. “Local storage” is not a promise of fully offline operation or that another agent/provider retains nothing.

## Credentials and permissions

A custom agent command runs as your user. Environment filtering limits accidental inheritance; it is not an OS sandbox and cannot stop a trusted executable from using files or Keychain access already available to that user. Choose its tools and authentication deliberately.

The portable bridge does not import mail, contacts, browser data, arbitrary folders, or private profiles. Optional extended connectors require separate setup. Full Disk Access is a broad OS permission: grant it only to the process context you intend to run, and review Apple's permissions UI.

## Logs and diagnostics

Do not attach live runtime directories or unredacted configuration/message output to an issue. Describe the error code and version, using synthetic IDs and paths. Portable transport logs should avoid raw messages and provider stderr; inspect them locally before sharing. A user-chosen agent can create its own logs beyond Potts's control.

## Deletion and backups

Use `/memory` and `/forget` for application-level memory control. Backups and external provider histories are separate copies. Local files are protected by user permissions, not application-level encryption. Consider your Mac's disk encryption and backup policy. See [memory](MEMORY.md) for retention and deletion boundaries.
