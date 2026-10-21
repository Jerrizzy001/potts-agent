#!/bin/bash
# Potts WP-2: print the Potts agent's EFFECTIVE tool list as reported by the running gateway
# (Gateway RPC tools.effective, operator.read, read-only).
#
#   effective-tools.sh --profile potts-test    # needs a running test gateway (wrap in scripts/profile/run-test-gateway.sh -- ...)
#   effective-tools.sh --live                  # owner: against the live gateway (read-only)
#   ... --session agent:main:telegram:direct:<owner-id> --raw
#   ... --check    fail unless the minimal policy and broker tools are effective
#   ... --owner-terminal --check  permits exec/process only with verified allowlist + ask-on-miss + deny fallback
#   ... --auto --check  personal-agent profile: exec/process (mode auto + model reviewer + strict inline eval), files,
#                      web fetch/search, browser, computer/nodes; direct messaging, config/plugin/secret tools,
#                      cron and sub-sessions still denied
# Without --session, discover the sole main-agent Telegram direct session (or sole
# main-agent session). Ambiguous sessions require an explicit selection.
#
# Output: {profile, available: [...], potts: [...], dangerousAvailable: [...]} where dangerousAvailable lists
# any available tool that can run code, write files, reach the network, drive the UI, message, or delegate.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
PROFILE=""; LIVE=0; SESSION=""; RAW=0; CREATE=0; CHECK=0; OWNER_TERMINAL=0; AUTO=0; COORDINATOR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --session) SESSION="$2"; shift 2 ;;
    --raw) RAW=1; shift ;;
    --check) CHECK=1; shift ;;
    --owner-terminal) OWNER_TERMINAL=1; shift ;;
    --auto) AUTO=1; shift ;;
    --coordinator) COORDINATOR=1; shift ;;
    --create-session) CREATE=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
select_target "$PROFILE" "$LIVE"
if [[ $COORDINATOR -eq 1 && -z "$SESSION" ]]; then die "--coordinator requires --session <coordinator session key>"; fi
if [[ -z "$SESSION" ]]; then
  if [[ -n "$PROFILE" ]]; then
    SESSION="agent:main:main"
  else
    if ! sessions="$("${OC[@]}" gateway call sessions.list --params '{"limit":100}' --json)"; then
      printf '%s\n' "$sessions" >&2
      die "could not discover a live session; use --session <key>"
    fi
    [[ "$(printf '%s' "$sessions" | jq -r '.hasMore // false')" == false ]] || die "session list is truncated; use --session <key>"
    SESSION="$(printf '%s' "$sessions" | jq -r '
      [.sessions[]? | .key | select(startswith("agent:main:"))] | unique |
      . as $all | map(select(test("^agent:main:telegram:direct:[0-9]+$"))) |
      if length == 1 then .[0] elif length == 0 and ($all|length) == 1 then $all[0] else empty end')"
    [[ -n "$SESSION" ]] || die "no unambiguous main-agent session; use --session <key>"
  fi
fi
if [[ $CREATE -eq 1 ]]; then
  [[ -n "$PROFILE" ]] || die "--create-session is only for test profiles"
  "${OC[@]}" gateway call sessions.create --params "{\"key\":\"$SESSION\",\"agentId\":\"main\"}" --json >/dev/null 2>&1 || true
fi
params="$(jq -nc --arg session "$SESSION" '{sessionKey:$session}')"
if ! out="$("${OC[@]}" gateway call tools.effective --params "$params" --json)"; then
  printf '%s\n' "$out" >&2
  die "tools.effective failed for $SESSION"
fi
summary="$(printf '%s\n' "$out" | jq '{
  profile,
  available: ([.toolAccess.tools[] | select(.status == "available") | .id] + [.groups[]?.tools[]?.id] | unique),
  potts: ([.groups[]?.tools[]?.id | select(startswith("potts_"))] | unique),
  dangerousAvailable: ([.toolAccess.tools[] | select(.status == "available") | .id] + [.groups[]?.tools[]?.id] | unique
    | map(select(test("^(exec|bash|process|code_execution|write|edit|apply_patch|browser|computer|nodes|screen|terminal|canvas|web_fetch|web_search|x_search|message|sessions_send|sessions_spawn|subagents|conversations_send|conversations_turn|gateway|openclaw|plugins|automations|cron|secrets|github_publish|telegram|imessage|discord|slack|whatsapp|signal|sms)$")))),
  excludedCount: ([.toolAccess.tools[] | select(.status != "available")] | length)
}')"
if [[ $RAW -eq 1 ]]; then printf '%s\n' "$out"; else printf '%s\n' "$summary"; fi
if [[ $CHECK -eq 1 ]]; then
  extras='[]'
  [[ $OWNER_TERMINAL -eq 1 ]] && extras='["exec","process"]'
  [[ $AUTO -eq 1 ]] && extras='["exec","process","write","edit","apply_patch","web_fetch","web_search","browser","computer","nodes","ls","dir_list","dir_fetch","file_fetch","ask_user","sessions_spawn","subagents","sessions_list","agents_wait","message","potts_send_screenshot","potts_send_voice","potts_send_file","potts_claude","potts_claude_status","potts_reminder","potts_delegate","potts_worker_status","potts_environment_status","potts_release_request","potts_release_status","cron","automations"]'
  [[ $COORDINATOR -eq 1 ]] && extras='["potts_delegate","potts_worker_status","potts_environment_status","potts_release_request","potts_release_status","potts_send_screenshot","potts_send_voice","potts_send_file","potts_reminder","cron","automations"]'
  printf '%s' "$summary" | jq -e --argjson extras "$extras" '
    .profile == "minimal" and ((.dangerousAvailable - $extras) | length) == 0 and
    ((["potts_propose_action","potts_action_status","potts_list_actions"] - .available) | length) == 0 and
    ((.available - ["read","memory_search","memory_get","session_status","potts_propose_action","potts_action_status","potts_list_actions","potts_memory_search","potts_drafts_list","potts_briefing_status","potts_capability_status","potts_read_content","potts_save_file","potts_delegation_report","potts_search_imessage","potts_memory_explain"] - $extras) | length) == 0
  ' >/dev/null || die "effective tool boundary failed for $SESSION; keep accounts disconnected and the daemon stopped. If this follows a hot reload, restart the gateway safely and recheck."
fi

if [[ $CHECK -eq 1 && $AUTO -eq 1 ]]; then
  "${OC[@]}" config get agents.entries.main.tools.exec --json | jq -e '
    .mode == "auto" and .strictInlineEval == true and (.reviewer.model | type) == "string" and .host == "gateway"
  ' >/dev/null || die "auto exec profile is not configured (need mode=auto, strictInlineEval, reviewer.model)"
  "${OC[@]}" config get tools.message.crossContext --json | jq -e '.allowWithinProvider == false and .allowAcrossProviders == false' >/dev/null || die "auto profile needs tools.message.crossContext locked to the current conversation"
  "${OC[@]}" config get agents.entries.main.tools.fs --json | jq -e '.workspaceOnly == true' >/dev/null || die "auto profile expects fs.workspaceOnly=true (unreviewed writes stay inside the workspace; other paths go through reviewed exec)"
fi
if [[ $CHECK -eq 1 && ( $OWNER_TERMINAL -eq 1 || $AUTO -eq 1 ) ]]; then
  "${OC[@]}" exec-policy show --agent main --json | jq -e '
    any(.effectivePolicy.scopes[]; .scopeLabel == "agent:main" and .security.effective == "allowlist" and .ask.effective == "on-miss" and .askFallback.effective == "deny")
  ' >/dev/null || die "owner terminal approval policy is not enforced"
fi

if [[ $CHECK -eq 1 && $COORDINATOR -eq 1 ]]; then
  printf '%s' "$summary" | jq -e '((["potts_delegate","potts_worker_status","potts_environment_status","potts_release_request","potts_release_status"] - .available)|length)==0 and ([.available[] | select(. == "exec" or . == "browser" or . == "message" or . == "sessions_spawn")]|length)==0' >/dev/null || die "coordinator tool boundary failed"
fi
