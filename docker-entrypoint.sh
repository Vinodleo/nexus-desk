#!/bin/sh
# Starts the app as the unprivileged "node" user. Hosts that mount the data
# volume owned by root (Fly.io, some Docker setups) would leave the app
# unable to save, so when started as root this hands the data directory to
# "node" first, then drops to it.
set -e
DATA_DIR="${NEXUS_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
