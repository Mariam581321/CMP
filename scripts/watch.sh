#!/usr/bin/env bash
# Live dashboard for a run: ./scripts/watch.sh [run-id]
# Thin wrapper: runner/status.js is the one dashboard; this just puts it under watch(1).
cd "$(dirname "$0")/.." || exit 1
FORCE_COLOR=1 exec watch --color -n 10 node runner/status.js "$@"
