#!/bin/bash
# Potts WP-2: end-to-end check of the potts-broker plugin in the ISOLATED test profile only.
#   integrations/openclaw/scripts/test-profile-e2e.sh
#
# 1. starts the fully wired daemon (fake providers, temp POTTS_HOME, random test ingress key)
# 2. points the test profile's potts-broker plugin config at it (env: key reference, fake owner id)
# 3. starts a short-lived test gateway and checks: plugin loaded, tools + commands registered, the
#    Potts agent's effective tools, a real tool call through the gateway (tools.invoke) that lands in
#    the broker as awaiting_approval, read tools reach the daemon, and exec is refused by gateway policy
# 4. stops everything. Never touches ~/.openclaw; no channel is enabled; no model turn is run.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
OC=(scripts/profile/oc-test.sh)
P=integrations/openclaw/config-patches

umask 077
export POTTS_TEST_INGRESS_KEY="$(openssl rand -hex 32)"
out="$(mktemp -t potts-e2e-broker)"
node --disable-warning=ExperimentalWarning tests/openclaw/support/run-test-broker.ts > "$out" 2>&1 &
bpid=$!
trap 'kill -TERM $bpid 2>/dev/null || true; sleep 1; rm -f "$out"' EXIT
for _ in $(seq 1 50); do grep -q '"home"' "$out" 2>/dev/null && break; sleep 0.2; done
HOME_DIR="$(head -1 "$out" | jq -r .home)"
[[ -S "$HOME_DIR/run/broker.sock" ]] || { cat "$out"; echo "test broker did not start" >&2; exit 1; }
echo "test broker home: $HOME_DIR"

patch="$(mktemp)"
jq -n --arg home "$HOME_DIR" '{plugins: {entries: {"potts-broker": {enabled: true, config: {pottsHome: $home, ownerTelegramId: "424242", ingressKeyRef: "env:POTTS_TEST_INGRESS_KEY", readSocket: ($home + "/run/read.sock"), memoryControlSocket: ($home + "/run/memory-control.sock"), ownerChannel: false}}}}}' > "$patch"
"${OC[@]}" config patch --file "$patch" --replace-path 'plugins.entries.potts-broker.config' >/dev/null
rm -f "$patch"
"${OC[@]}" plugins enable potts-broker --accept-capabilities >/dev/null
integrations/openclaw/config-patches/apply-tool-constraints.sh --profile potts-test --apply >/dev/null

scripts/profile/run-test-gateway.sh --max-seconds 240 -- bash -c '
set -euo pipefail
OC=(scripts/profile/oc-test.sh); P=integrations/openclaw/config-patches
echo "=== plugin runtime ==="
"${OC[@]}" plugins inspect potts-broker --runtime --json | jq -ce "if .plugin.status == \"loaded\" and (.diagnostics | length) == 0 then {status: .plugin.status, tools: [.tools[].names[]], commands, diagnostics} else error(\"plugin failed to load cleanly\") end"
echo "=== commands.list (potts commands) ==="
"${OC[@]}" gateway call commands.list --params "{\"agentId\":\"main\",\"scope\":\"text\",\"includeArgs\":false}" --json | jq -ce "[.. | objects | select(has(\"name\")) | .name | select(test(\"^(claude|potts|pstatus|pause|resume|approvals|papprove|deny|cancel|revoke|forget)$\"))] | unique | if (([\"claude\",\"potts\",\"pstatus\",\"pause\",\"resume\",\"approvals\",\"papprove\",\"deny\",\"cancel\",\"revoke\",\"forget\"] - .) | length) == 0 then . else error(\"owner commands are missing\") end"
echo "=== effective tools of the Potts agent ==="
$P/effective-tools.sh --profile potts-test --create-session --check | jq -ce "if (([\"potts_capability_status\",\"potts_briefing_status\",\"potts_drafts_list\",\"potts_memory_search\"] - .available) | length) == 0 then . else error(\"daemon read tools are not available to the agent\") end"
echo "=== tools.invoke potts_propose_action (through the gateway) ==="
proposal=$("${OC[@]}" gateway call tools.invoke --params "{\"name\":\"potts_propose_action\",\"sessionKey\":\"agent:main:main\",\"args\":{\"kind\":\"send_message\",\"accountId\":\"gmail-personal\",\"destination\":[\"bob@example.com\"],\"payload\":{\"channel\":\"email\",\"to\":[\"bob@example.com\"],\"subject\":\"Harness check\",\"body\":\"e2e test\"}}}" --json)
printf "%s\n" "$proposal" | jq -ce "if .ok == true and .output.details.ok == true and .output.details.status == \"awaiting_approval\" then {ok, actionId: .output.details.actionId, status: .output.details.status} else error(\"proposal did not create a pending approval\") end"
action=$(printf "%s" "$proposal" | jq -er .output.details.actionId)
params=$(jq -nc --arg id "$action" "{name:\"potts_action_status\",sessionKey:\"agent:main:main\",args:{actionId:\$id}}")
"${OC[@]}" gateway call tools.invoke --params "$params" --json | jq -e ".ok == true and .output.details.ok == true and .output.details.action.status == \"awaiting_approval\"" >/dev/null
echo "=== read tools (through the gateway to the daemon) ==="
for name in potts_capability_status potts_briefing_status potts_drafts_list; do
  params=$(jq -nc --arg name "$name" "{name:\$name,sessionKey:\"agent:main:main\",args:{}}")
  "${OC[@]}" gateway call tools.invoke --params "$params" --json | jq -ce "if .ok == true and .output.details.ok == true then {ok,toolName} else error(\"daemon read tool failed\") end"
done
"${OC[@]}" gateway call tools.invoke --params "{\"name\":\"potts_memory_search\",\"sessionKey\":\"agent:main:main\",\"args\":{\"query\":\"Potts harness fixture\"}}" --json | jq -e ".ok == true and .output.details.ok == true and (.output.details.result | length) == 1" >/dev/null
echo "=== tools.invoke exec (must be refused by policy) ==="
"${OC[@]}" gateway call tools.invoke --params "{\"name\":\"exec\",\"sessionKey\":\"agent:main:main\",\"args\":{\"command\":\"id\"}}" --json | jq -ce "if .ok == false and .error.code == \"not_found\" then {ok,error} else error(\"exec was not refused by tool policy\") end"
echo "=== tools.invoke web_fetch (must be refused by policy) ==="
"${OC[@]}" gateway call tools.invoke --params "{\"name\":\"web_fetch\",\"sessionKey\":\"agent:main:main\",\"args\":{\"url\":\"https://example.com\"}}" --json | jq -ce "if .ok == false and .error.code == \"not_found\" then {ok,error} else error(\"web_fetch was not refused by tool policy\") end"
'
kill -TERM $bpid; wait $bpid 2>/dev/null || true
echo "=== broker state after the run ==="
tail -1 "$out" | jq -ce 'if (.actions | length) == 1 and .actions[0].kind == "send_message" and .actions[0].status == "awaiting_approval" and .sends == 0 then . else error("broker evidence did not match the approved test scenario") end'
