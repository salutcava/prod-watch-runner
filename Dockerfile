# Prod Watch Runner - image Docker multi-stage avec bundling/minification de qa-saas
#
# Stage 1 (builder) :
#   - Clone qa-saas (repo prive) depuis git
#   - Bundle + minify le runner CLI via esbuild en 1 seul fichier qa-saas.bundle.cjs
#   - Le code source en clair de qa-saas n'apparait JAMAIS dans l'image finale
#
# Stage 2 (runtime) :
#   - Base Playwright officielle Microsoft (Chromium + deps systeme deja installes)
#   - Copie uniquement le bundle minifie + le code du runner (boucle poll)
#   - CMD : node src/poll.mjs

# ============================================================================
# STAGE 1 - BUILDER : bundle qa-saas + minif
# ============================================================================
FROM node:22-alpine AS builder
WORKDIR /build
ARG GITHUB_TOKEN
ARG QA_SAAS_REF=main

RUN apk add --no-cache git

# Clone qa-saas. Le GITHUB_TOKEN est passé en --build-arg, JAMAIS commit.
# Il sert UNIQUEMENT au clone et disparait avec le stage builder (eph monorepo).
RUN git clone --depth 1 --branch "${QA_SAAS_REF}" \
    "https://${GITHUB_TOKEN}@github.com/salutcava/qa-saas.git" qa-saas

WORKDIR /build/qa-saas
RUN npm ci --omit=dev

# Bundle + minify : tout qa-saas en 1 fichier qa-saas.bundle.cjs
# - --minify : reduit le code et renomme les variables (a/b/c)
# - --keep-names=false : pas de preservation des noms de fonctions
# - --legal-comments=none : retire les commentaires/licences inline
# - --bundle : resout tous les imports en 1 fichier
# - --external:* (TODO V2 si certaines deps natives doivent etre laissees)
RUN npx --yes esbuild scripts/runner-cli.js \
    --bundle \
    --platform=node \
    --target=node22 \
    --format=cjs \
    --minify \
    --keep-names=false \
    --legal-comments=none \
    --outfile=/build/qa-saas.bundle.cjs

# ============================================================================
# STAGE 2 - RUNTIME : image finale legere
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Metadata pour identifier l'image (utile dans `docker inspect`)
LABEL org.opencontainers.image.title="Prod Watch Runner"
LABEL org.opencontainers.image.description="Self-hosted Docker runner for Prod Watch QA managed service"
LABEL org.opencontainers.image.vendor="LAMSTER"
LABEL org.opencontainers.image.source="https://github.com/salutcava/prod-watch-runner"

WORKDIR /app

# Copie UNIQUEMENT le bundle minifie de qa-saas (pas les sources)
COPY --from=builder /build/qa-saas.bundle.cjs /app/qa-saas/runner.cjs

# Copie le code du runner (notre boucle poll). Code "plomberie" sans valeur
# strategique, lisible OK.
COPY package.json /app/
COPY src /app/src

# Pas de devDependencies (vitest etc.) en runtime, et le runner n'a aucune
# dependance runtime tierce (fetch natif Node 22, pas de node_modules).
# Si on en ajoute plus tard, ajouter "npm ci --omit=dev" ici.

# Variables d'env par defaut (peuvent etre override par `-e VAR=...`)
ENV PROD_WATCH_URL=https://app.prod-watch.com
ENV POLL_INTERVAL_MS=10000
ENV HEARTBEAT_INTERVAL_MS=30000
ENV QA_SAAS_PATH=/app/qa-saas
ENV QA_SAAS_ENTRY=/app/qa-saas/runner.cjs
ENV NODE_ENV=production

# Le runner ne fait pas de bind sur un port (poll only sortant). Pas de EXPOSE.
# Lancement direct sans pid 1 wrapper (Node gere SIGTERM/SIGINT correctement).
CMD ["node", "/app/src/poll.mjs"]
