#!/bin/sh
# End-to-end self-test: daemon + window + snapshot/refs + actions + tabs + stop.
DIR=$(cd "$(dirname "$0")/.." && pwd)
exec node "$DIR/scripts/smoke.ts" "$@"
