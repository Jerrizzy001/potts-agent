# Bring your own agent

Potts supplies the messaging bridge and memory context. You supply the agent. Changing an agent's underlying model is handled in that agent's own configuration; connecting a different agent uses an adapter.

## Command adapter

Configure `agent.kind` as `command`, with `argv` containing an absolute executable path followed by its arguments. The command runs without a shell. It is trusted code with your user's operating-system privileges, not an isolated worker. Select only the environment variable names it needs through `envNames`; do not put their values in the configuration.

Each invocation receives one JSON request on standard input:

```json
{"version":1,"id":"opaque-request-id","message":"Remember that I prefer short answers.","context":"Source-linked notes supplied by Potts"}
```

Return one JSON object on stdout, then exit successfully:

```json
{"version":1,"id":"opaque-request-id","text":"Understood. I'll keep explanations concise."}
```

Return the same request ID. Stdout is protocol output only; do not print progress banners there. Keep stderr free of private inputs or credentials. Requests and responses are bounded and time-limited; malformed JSON, mismatched IDs, and unsuccessful exits fail the turn. Never report an action as completed solely because the model said it was.

The context is retrieved data. It must not override the current owner request, agent policies, or permissions. The portable response only returns text; it cannot choose another recipient or grant itself a new tool. The connected agent may have its own tools—configure those separately and understand their authority.

## OpenClaw adapter

Choose `agent.kind: "openclaw"`, an absolute `binary`, an existing `agentId`, optional `profile`, and explicitly needed `envNames`. Potts invokes the documented `openclaw agent` command with JSON output and without `--deliver`; Potts handles the response to the owner.

Authenticate and configure that agent with OpenClaw's own setup. Do not import someone else's config. Provider/model choice remains yours. See the [official agent CLI documentation](https://docs.openclaw.ai/cli/agent).

## Test before connecting Messages

Start with the built-in demo agent and `npm run public:demo`. Use the included example adapter and portable tests as executable protocol examples. Then run doctor against your configured home. A successful protocol test does not prove the selected provider is authenticated; verify a real request before enabling the background service.

Do not advertise a provider as supported solely because it speaks a similarly named API. An agent must satisfy this exact contract or the documented OpenClaw adapter.

## Complete command configuration

Use `command -v node` and the absolute path of this clone to replace the paths below. The example is a deterministic protocol adapter, not a language model. Keep the transport set to demo until a real agent is configured; the live bridge refuses the built-in demo agent.

```json
{
  "version": 1,
  "timezone": "UTC",
  "timeoutMs": 120000,
  "transport": { "kind": "demo" },
  "agent": {
    "kind": "command",
    "argv": ["/absolute/path/to/node", "/absolute/path/to/potts-agent/examples/stdio-agent.mjs"],
    "envNames": []
  }
}
```

The example can be checked without Messages:

```sh
printf '%s\n' '{"version":1,"id":"example-1","message":"Hello","context":""}' | node examples/stdio-agent.mjs
```

To use a real custom agent, replace `argv` with its protocol wrapper. For real iMessage, replace the transport object with the validated `imsg` object shown in [iMessage setup](IMESSAGE.md); that page also contains the complete OpenClaw configuration. A demo transport plus a custom agent is useful for validation, but `public:demo` intentionally runs only the built-in demo pair and `public:run` intentionally requires live iMessage.
