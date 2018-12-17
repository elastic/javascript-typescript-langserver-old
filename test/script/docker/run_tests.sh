#!/usr/bin/env bash

# This is currently build script stub. Will populate this file
# with the actual build/test steps later.

set -e

if [ $# -lt 1 ]; then
  echo "Nodejs version missing"
  exit 2
fi

# Build the docker image with Node.
docker build --pull --force-rm \
  --build-arg NODE_VERSION=$1 \
  -t code-lsp-javascript-typescript:node-${1} \
  ./test

# TODO(mengwei): complete the build steps in here
echo "Hello World"

