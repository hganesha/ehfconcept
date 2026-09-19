#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_REGISTRY:?Set IMAGE_REGISTRY, for example ghcr.io/acme/ehf}"
revision="${IMAGE_REVISION:-$(git rev-parse HEAD)}"

publish() {
  local service="$1"
  local dockerfile="$2"
  local image="${IMAGE_REGISTRY}/${service}:${revision}"
  shift 2
  docker buildx build \
    --file "$dockerfile" \
    --platform "${IMAGE_PLATFORMS:-linux/amd64,linux/arm64}" \
    --label "org.opencontainers.image.revision=${revision}" \
    --provenance=mode=max \
    --sbom=true \
    --push \
    --tag "$image" \
    "$@" .
  docker buildx imagetools inspect "$image" --format '{{.Name}}@{{.Manifest.Digest}}'
}

for service in control-api capability-gateway case-api runtime-host runtime-worker; do
  publish "$service" Dockerfile --build-arg "SERVICE_NAME=${service}" --build-arg "IMAGE_REVISION=${revision}"
done
publish control-ui Dockerfile.ui
