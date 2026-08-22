#!/usr/bin/env bash
#
# Model-check every configuration in this directory.
#
# TLC is not vendored: tla2tools.jar bundles Eclipse components under EPL-2.0
# and this repository is MIT with no dependencies. Fetch it once with
#
#   ./fetch-tools.sh
#
# Three of the six models are EXPECTED to report a violated invariant. See
# RESULTS.md; the exit status of this script is the number of models whose
# outcome differed from what RESULTS.md records.

set -u

here="$(cd "$(dirname "$0")" && pwd)"
jar="$here/tools/tla2tools.jar"

if [ ! -f "$jar" ]; then
  echo "tools/tla2tools.jar is missing. Run ./fetch-tools.sh first." >&2
  exit 2
fi

# config:expected — "clean", or "refuted" for a model RESULTS.md records as
# finding a real counterexample. Which invariant TLC reports first depends on
# worker scheduling, so the models with findings are matched on "some
# invariant was refuted" rather than on a particular one.
models=(
  "Sagaflow.cfg:refuted"
  "SagaflowProven.cfg:clean"
  "SagaflowDeep.cfg:clean"
  "SagaflowNoCancel.cfg:clean"
  "SagaflowRandomIds.cfg:refuted"
  "SagaflowLiveSweep.cfg:refuted"
)

unexpected=0

for entry in "${models[@]}"; do
  config="${entry%%:*}"
  expected="${entry##*:}"
  output="$(java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
    -config "$here/$config" -workers auto -cleanup "$here/Sagaflow.tla" 2>&1)"

  violated="$(printf '%s\n' "$output" | sed -n 's/^Error: Invariant \(.*\) is violated\.$/\1/p' | head -1)"
  states="$(printf '%s\n' "$output" | sed -n 's/^\([0-9]*\) states generated, \([0-9]*\) distinct states found.*/\1 generated, \2 distinct/p' | tail -1)"
  if [ -n "$violated" ]; then outcome="refuted"; else outcome="clean"; violated="clean"; fi

  if [ "$outcome" = "$expected" ]; then
    verdict="as recorded"
  else
    verdict="UNEXPECTED (RESULTS.md says $expected)"
    unexpected=$((unexpected + 1))
  fi

  printf '%-26s %-30s %-22s %s\n' "$config" "$violated" "$states" "$verdict"
done

exit "$unexpected"
