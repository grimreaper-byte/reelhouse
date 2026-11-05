#!/bin/sh
# Container entrypoint: makes sure the config volume belongs to PUID:PGID (default 1000:1000).
# The server then switches to that user itself before creating any files
# (see server/lib/privileges.js).
set -e

DATA="${REELHOUSE_DATA:-/config}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  export PUID PGID
  mkdir -p "$DATA"
  # Docker creates missing bind-mount folders as root; hand them to the runtime user.
  if [ "$(stat -c %u "$DATA")" != "$PUID" ]; then
    chown -R "$PUID:$PGID" "$DATA"
  fi
fi

exec "$@"
