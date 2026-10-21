#!/usr/bin/env bash
# Potts WP-0: run an `openclaw` command against the isolated TEST profile only.
#
# Usage: oc-test.sh [--name potts-test] <openclaw args...>
#   e.g. oc-test.sh plugins list --json
#        oc-test.sh plugins install -l ./integrations/openclaw/potts-broker --force
#
# Clears every OPENCLAW_* env var, always passes --profile <name>, and refuses commands that
# would install/alter services, update the runtime, reset state, or enable channels.
set -euo pipefail
# shellcheck source=../baseline/lib.sh
source "$(cd "$(dirname "$0")/../baseline" && pwd)/lib.sh"

NAME="potts-test"
if [[ "${1:-}" == "--name" ]]; then NAME="$2"; shift 2; fi
[[ $# -gt 0 ]] || die "usage: oc-test.sh [--name N] <openclaw args...>"
[[ -f "$HOME/.openclaw-$NAME/POTTS_TEST_PROFILE" ]] || die "~/.openclaw-$NAME is not a Potts test profile"

joined=" $* "
for bad in " --profile " " --dev " " --container " " update " " uninstall " " reset " " daemon " \
           " gateway install" " gateway uninstall" " gateway restart" " gateway stop" " gateway start" \
           " node install" " onboard " " configure " " channels add" " channels login" " pairing " " qr " \
           " --tailscale" " --bind lan" " --bind tailnet" " --bind auto" " --bind custom"; do
  [[ "$joined" == *"$bad"* ]] && die "refused for the test profile: '${bad# }'"
done
if [[ "$joined" == *" config set "* || "$joined" == *" config patch "* ]] && \
   [[ "$joined" =~ channels\.[a-z-]+\.enabled[[:space:]]+true || "$joined" == *"gateway.bind"* || "$joined" == *"gateway.port"* ]]; then
  die "refused: test profile must keep channels disabled and gateway port/bind unchanged"
fi

clean_openclaw_env
export OPENCLAW_DISABLE_BONJOUR=1
exec openclaw --profile "$NAME" "$@"
