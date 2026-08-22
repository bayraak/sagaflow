#!/usr/bin/env bash
#
# Fetch the TLA+ tools.
#
# tla2tools.jar is not checked in. Its own code is MIT (Microsoft Research),
# but the published jar bundles Eclipse components under EPL-2.0, and this
# repository is MIT with an empty dependencies field. Redistributing the jar
# would put an EPL obligation inside an MIT package for no benefit: the file
# is one download away and the release is immutable.

set -eu

version="v1.7.4"
here="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$here/tools"
curl -fsSL -o "$here/tools/tla2tools.jar" \
  "https://github.com/tlaplus/tlaplus/releases/download/$version/tla2tools.jar"

java -cp "$here/tools/tla2tools.jar" tlc2.TLC -h >/dev/null 2>&1 \
  && echo "TLA+ tools $version ready in formal/tools/"
