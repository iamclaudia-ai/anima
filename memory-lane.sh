#!/usr/bin/env bash
# Convenience script to run memory-lane from anywhere in the project
node "$(dirname "$0")/packages/memory-lane/dist/index.js" "$@"
