#!/bin/sh
# Potts exec guard (installed by deploy/exec-guard/install.sh into $POTTS_HOME/bin/guard,
# which tools.exec.pathPrepend puts first on the Potts agent's PATH).
# The owner's rule: deleting is irreversible and always needs their explicit yes first.
# This wrapper runs nothing. It is a speed bump for the common case; the gateway's exec
# reviewer still judges the real /bin/<cmd> when the agent runs it after the owner agrees.
cmd="$(basename "$0")"
printf '%s\n' "Potts guard: '$cmd $*' was NOT run. Deleting files or folders is irreversible and needs the owner's explicit yes in this chat first. Ask the owner in plain words (do not invent commands or approval codes). Once the owner says yes to exactly this deletion, run /bin/$cmd with the same arguments; the gateway will then ask the owner to confirm that exact command." >&2
exit 126
