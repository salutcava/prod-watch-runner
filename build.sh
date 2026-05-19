#!/usr/bin/env bash
# Build + publish de l'image Docker prod-watch-runner.
#
# Usage :
#   GITHUB_TOKEN=ghp_xxx ./build.sh [tag]   # tag = "latest" par defaut
#
# Prerequis :
#   - Docker buildx setup (docker buildx create --use une fois pour toutes)
#   - GITHUB_TOKEN avec read:packages + read scope sur qa-saas (repo prive)
#   - Authentifie sur GHCR : echo $GITHUB_TOKEN | docker login ghcr.io -u salutcava --password-stdin
set -euo pipefail

IMAGE="ghcr.io/salutcava/prod-watch-runner"
TAG="${1:-latest}"
QA_SAAS_REF="${QA_SAAS_REF:-main}"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERREUR : GITHUB_TOKEN requis pour cloner qa-saas (repo prive)" >&2
  echo "Usage : GITHUB_TOKEN=ghp_xxx ./build.sh [tag]" >&2
  exit 1
fi

echo "==> Build et push ${IMAGE}:${TAG} (qa-saas ref: ${QA_SAAS_REF})"
echo "    Architectures : linux/amd64 + linux/arm64"
echo ""

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --secret "id=github_token,env=GITHUB_TOKEN" \
  --build-arg "QA_SAAS_REF=${QA_SAAS_REF}" \
  --tag "${IMAGE}:${TAG}" \
  --tag "${IMAGE}:$(date -u +%Y%m%d-%H%M%S)" \
  --push \
  .

echo ""
echo "==> OK : ${IMAGE}:${TAG} publie sur GHCR"
echo ""
echo "Pour tester chez un client :"
echo "  docker run -d \\"
echo "    --name prod-watch-runner \\"
echo "    --restart unless-stopped \\"
echo "    -e RUNNER_TOKEN=pwr_<slug>_<hex> \\"
echo "    ${IMAGE}:${TAG}"
