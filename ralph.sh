#!/bin/bash

set -e

ITERATIONS="${1:-10}"

for ((i=1; i<=${ITERATIONS}; i++)); do
  echo "--- Iteration $i of ${ITERATIONS} ---"

  result=$(claude -p "$(cat PROMPT.md)")

  echo "$result"

  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "All tasks complete after $i iterations."
    exit 0
  fi
done

echo "Reached max iterations (${ITERATIONS})."
