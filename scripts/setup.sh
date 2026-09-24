#!/bin/sh
# Bootstrap: check Node, make sure `playwright` resolves and Chromium is installed.
DIR=$(cd "$(dirname "$0")/.." && pwd)
exec node "$DIR/scripts/setup.ts" "$@"
