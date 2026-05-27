# syntax=docker/dockerfile:1.7
# Prod Watch Runner - image Docker multi-stage avec bundling du moteur qa-saas.
#
# Architecture (V0.2+) :
#   - Le moteur qa-saas (engine/, runner/, utils/) est bundle/minifie via esbuild
#     en 1 fichier .cjs opaque : runner.bundle.cjs (entry-point Playwright,
#     ex-dynamic.spec.ts inline avec ses imports recursifs).
#   - Le source TypeScript de qa-saas n'apparait JAMAIS dans l'image finale ;
#     seul scripts/runner-execute.js (orchestrateur clair, ~340 LOC) est embarque
#     pour faciliter le debug client.
#   - global-setup.ts NON bundle en V1 (incompat path resolution, cf. note plus bas).
#   - Les configs/<slug>.json et scenarios/<name>.json client-specifiques NE
#     SONT PAS bakes : ils sont fournis au runtime par le dashboard via le
#     payload de POST /api/runner/poll, ecrits en temp par src/executor.mjs,
#     consommes par Playwright, puis unlinks dans le finally.
#
# Stage 1 (builder Alpine) :
#   - Clone qa-saas (token via BuildKit secret = pas de fuite dans les layers)
#   - npm ci --omit=dev pour avoir @playwright/test et ses deps
#   - esbuild bundle runner/dynamic.spec.ts (external: @playwright/test)
#   - Genere playwright.runner.config.js minimal qui pointe vers le bundle
#
# Stage 2 (runtime) :
#   - Base Playwright officielle Microsoft (Chromium + libs systeme deja installes)
#   - Copy uniquement les bundles, node_modules, runner-execute.js, playwright config
#   - CMD : node src/poll.mjs (notre boucle Node)

# ============================================================================
# STAGE 1 - BUILDER : bundle qa-saas (engine + runner) + minif
# ============================================================================
FROM node:22-alpine AS builder
WORKDIR /build
ARG QA_SAAS_REF=main

RUN apk add --no-cache git

# Clone qa-saas (repo prive). Token via BuildKit secret : non persiste dans les
# layers ni le cache buildx. Cf. doc Docker `--mount=type=secret`.
RUN --mount=type=secret,id=github_token,required=true \
    git clone --depth 1 --branch "${QA_SAAS_REF}" \
      "https://$(cat /run/secrets/github_token)@github.com/salutcava/qa-saas.git" \
      qa-saas

WORKDIR /build/qa-saas
RUN npm ci --omit=dev

# Bundle 1 : runner.bundle.cjs (entry-point Playwright, ex-dynamic.spec.ts).
# - --external:@playwright/test : laisse Playwright resoudre lui-meme (require natif)
# - --keep-names : Playwright a besoin des noms des test.describe/test pour la detection
# - --minify + --legal-comments=none : code opaque, pas de commentaires/licences
# - Output sous runner/ pour que __dirname/../configs/ dans le bundle pointe vers
#   /app/qa-saas/configs/ une fois copie a la cible.
RUN npx --yes esbuild runner/dynamic.spec.ts \
    --bundle \
    --platform=node \
    --target=node22 \
    --format=cjs \
    --external:@playwright/test \
    --minify \
    --keep-names \
    --legal-comments=none \
    --outfile=/build/out/runner/runner.bundle.cjs

# NOTE V1 : on ne bundle PAS global-setup.ts. Raison : son code source assume
# d'etre a la racine qa-saas (path.resolve(__dirname, '.auth')) tandis que
# engine/loader.ts qu'il importe assume d'etre sous engine/ (__dirname/../configs).
# Au runtime, __dirname dans le bundle resout au dossier du .cjs, pas a celui
# de chaque module source : impossible de satisfaire les deux dans un fichier
# bundle unique. Skip global-setup = pas de pre-creation des storage states ;
# chaque scenario qui doit s'authentifier le fera lui-meme (plus lent que la
# baseline qa-saas locale mais fonctionnel). V2 a faire : refactor de
# global-setup.ts pour utiliser des env vars QA_SAAS_AUTH_DIR/SCENARIOS_DIR.

# Genere un playwright.runner.config.js minimal pointant vers le bundle.
# - testDir './runner' + testMatch sur le bundle (pas de wildcard sur *.spec.ts)
# - Pas de globalSetup (cf. note ci-dessus, V1)
# - reporter json + html sous RUN_OUTPUT_DIR (meme convention que le config
#   original de qa-saas, cf. playwright.config.ts)
RUN cat > /build/out/playwright.runner.config.js <<'CFG'
const rd = process.env.RUN_OUTPUT_DIR || '';
module.exports = {
  testDir: './runner',
  testMatch: 'runner.bundle.cjs',
  timeout: 60000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: { mode: 'retain-on-failure', sources: false },
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: rd ? `${rd}/playwright-report` : 'playwright-report' }],
    ['json', { outputFile: rd ? `${rd}/test-results/results.json` : 'test-results/results.json' }],
  ],
  outputDir: rd ? `${rd}/test-results` : 'test-results',
};
CFG

# Garde aussi le package.json (minimal pour Playwright resolve) et le
# scripts/runner-execute.js qu'on garde en clair (orchestrateur, pas du
# moteur sensible).
RUN cp package.json /build/out/package.json \
    && mkdir -p /build/out/scripts \
    && cp scripts/runner-execute.js /build/out/scripts/runner-execute.js

# ============================================================================
# STAGE 2 - RUNTIME : image finale legere
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

LABEL org.opencontainers.image.title="Prod Watch Runner"
LABEL org.opencontainers.image.description="Self-hosted Docker runner for Prod Watch QA managed service"
LABEL org.opencontainers.image.vendor="LAMSTER"
LABEL org.opencontainers.image.source="https://github.com/salutcava/prod-watch-runner"

WORKDIR /app

# Copy le moteur qa-saas (bundle minifie + orchestrateur + config + deps).
# AUCUNE source TypeScript n'est embarquee : engine/, runner/, utils/ sont
# entierement contenus dans runner.bundle.cjs.
COPY --from=builder /build/out/runner /app/qa-saas/runner
COPY --from=builder /build/out/playwright.runner.config.js /app/qa-saas/playwright.runner.config.js
COPY --from=builder /build/out/scripts /app/qa-saas/scripts
COPY --from=builder /build/out/package.json /app/qa-saas/package.json
COPY --from=builder /build/qa-saas/node_modules /app/qa-saas/node_modules

# Pre-cree les dossiers qui seront populated au runtime par src/executor.mjs.
# Les fichiers configs/<slug>.json et scenarios/<name>.json arrivent dans le
# payload du job (POST /api/runner/poll) et sont ecrits avant chaque spawn
# Playwright, puis unlinks dans le finally pour eviter qu'un job N+1 herite
# par accident des fichiers du job N.
RUN mkdir -p /app/qa-saas/configs /app/qa-saas/scenarios /app/qa-saas/.auth

# Copy notre code Node (la boucle poll). Plomberie sans valeur strategique,
# garde en clair pour le debug client.
COPY package.json /app/
COPY src /app/src

# Pas de devDependencies (vitest etc.) en runtime, le runner Node n'a aucune
# dependance runtime tierce (fetch natif Node 22).

# Hardening secu V0.2.2 : drop le root. La base mcr.microsoft.com/playwright
# ship un user `pwuser` UID 1000 dedie pour faire tourner Chromium sans
# privileges. On chown tout /app vers pwuser puis on switch.
# Pourquoi : si un exploit chromium 0day passe, l'attaquant est limite a UID
# 1000 dans le container. Combine a un docker run --read-only + --tmpfs cote
# client (cf. doc Production setup), surface d'attaque tres reduite.
# /tmp/runner.health (HEALTHCHECK) reste writable car /tmp = mode 1777.
RUN chown -R pwuser:pwuser /app
USER pwuser

# Variables d'env par defaut (peuvent etre override par `-e VAR=...`)
ENV PROD_WATCH_URL=https://app.prod-watch.com
ENV POLL_INTERVAL_MS=10000
ENV HEARTBEAT_INTERVAL_MS=30000
ENV QA_SAAS_PATH=/app/qa-saas
ENV QA_SAAS_ENTRY=/app/qa-saas/scripts/runner-execute.js
# Pointe runner-execute vers le bundle minifie + le config genere
# (cf. qa-saas/scripts/runner-execute.js qui lit ces 2 env).
ENV RUNNER_PW_ENTRY=runner/runner.bundle.cjs
ENV RUNNER_PW_CONFIG=playwright.runner.config.js
ENV NODE_ENV=production

# Le runner ne fait pas de bind sur un port (poll only sortant). Pas de EXPOSE.

# Healthcheck : la boucle ecrit /tmp/runner.health a chaque iteration. Si le
# fichier devient obsolete (>90s = 3 heartbeats rates), Docker passe le
# container "unhealthy". start_period = 60s pour tolerer un demarrage lent
# (npm/playwright cold start) avant la 1ere verif.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=2 \
  CMD ["node", "/app/src/healthcheck.mjs"]

# Lancement direct sans pid 1 wrapper (Node gere SIGTERM/SIGINT correctement).
CMD ["node", "/app/src/poll.mjs"]
