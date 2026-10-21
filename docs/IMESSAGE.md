# iMessage setup

Live messaging runs on macOS 14 or newer with Messages signed in. The portable bridge uses the public [`imsg`](https://github.com/openclaw/imsg) CLI, not an iMessage cloud API.

## Install and permissions

Follow the [official install guide](https://imsg.sh/install.html). The Homebrew command is:

```sh
brew install steipete/tap/imsg
command -v imsg
imsg --version
```

Use the absolute binary path in Potts configuration. Grant Full Disk Access to the process context reading Messages, then reopen that context. Grant Automation → Messages for sending. A LaunchAgent can require permission grants separately from the terminal used during setup. See [upstream permissions](https://imsg.sh/permissions.html).

Basic text messaging does not require disabling System Integrity Protection. Potts's portable path does not use private API injection or advanced message mutation.

## Choose one direct conversation

Use a Messages account for the assistant that the owner can contact from a different account/handle. Sending to yourself through the same synced Apple ID can be marked `is_from_me`; those messages are deliberately ignored to avoid reply loops.

Have the owner send a fresh message. Inspect the selected direct conversation locally:

```sh
imsg chats --limit 10 --json
imsg group --chat-id 42 --json
```

Replace `42` with the selected positive chat ID. The `group` command also reports direct-chat metadata. Required metadata: matching `id`, `is_group: false`, `service: "iMessage"`, and exactly one `participants` entry matching the configured owner handle. Use the actual returned phone/email string, not a contact name. The runtime checks that metadata again before every send.

Recent `imsg` versions also include `chat_id`, `sender`, `is_from_me`, `is_group`, and `participants` in streamed message JSON. Potts fails closed if these fields are missing or inconsistent. See upstream [JSON schema](https://imsg.sh/json.html) and [group metadata](https://github.com/openclaw/imsg/blob/main/docs/groups.md).

## Configuration example

Edit the private runtime `config.json`, never a tracked repository file. Replace every placeholder with the user's selected values. This example uses an existing OpenClaw agent:

```json
{
  "version": 1,
  "timezone": "UTC",
  "timeoutMs": 120000,
  "transport": {
    "kind": "imsg",
    "binary": "/absolute/path/to/imsg",
    "chatId": 42,
    "owner": "+14155550123"
  },
  "agent": {
    "kind": "openclaw",
    "binary": "/absolute/path/to/openclaw",
    "agentId": "your-agent-id",
    "envNames": []
  }
}
```

The number is a fictional example, not a default recipient. Only the configured owner and chat are admitted. Groups, self-authored messages, reactions, and messages without verifiable metadata are not agent requests.

## Verify the actual path

Run doctor, then the foreground bridge. Send a new message from the owner account. Check the reply on the owner's device. Repeat after installing the background service. `imsg send` succeeding means the CLI accepted the send; it does not establish recipient delivery or reading.

Messages missed while the bridge is stopped are not replayed. Failed or uncertain send attempts are not automatically retried. After resolving a failure, send a fresh owner request rather than deleting the ledger to replay old work.

## Troubleshooting

| Symptom | Check |
|---|---|
| Cannot read Messages | Full Disk Access for the real launch context; reopen it |
| Metadata rejected | Recent imsg, direct chat, exact participant and iMessage service |
| No response to self-chat | Use a distinct owner/assistant account; self-authored messages are ignored |
| Agent fails | Test its own authentication and adapter protocol locally |
| Foreground works, service fails | Absolute executable paths, service permissions, credentials available without shell exports |
| Send uncertainty | Inspect the intended conversation before requesting a new attempt |
| Nothing arrives while Mac sleeps | Keep the Mac awake and network available; this is not remote hosting |

Do not upload chat output or the Messages database to an issue.
