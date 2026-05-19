# Prod Watch Runner

Container Docker self-hosted qui execute les tests Playwright Prod Watch sur l'infrastructure d'un client (plan Scale / Enterprise).

Le runner se connecte au dashboard Prod Watch via HTTPS sortant uniquement, recupere les jobs assignes a son client, execute les scenarios localement (acces aux environnements internes / staging / VPN sans expositions externes), et pousse les resultats vers le dashboard.

## Doc utilisateur

L'installation et la configuration cote client sont documentees sur :

https://app.prod-watch.com/docs?doc=runner-self-hosted

## Architecture

```
Client (votre infra)              Prod Watch (chez nous)
─────────────────────             ──────────────────────
prod-watch-runner                 Dashboard + API
   │                                   │
   │  POST /api/runner/heartbeat       │
   │ ────────────────────────────────► │  (toutes les 30s)
   │                                   │
   │  POST /api/runner/poll            │
   │ ────────────────────────────────► │  (toutes les 10s)
   │ ◄──────────────────────────────── │  Job a executer
   │                                   │
   │  Lance Playwright sur staging    │
   │  / preprod accessibles localement │
   │                                   │
   │  POST /api/admin/push-run         │
   │ ────────────────────────────────► │  Resultats (status,
   │ ◄──────────────────────────────── │   videos, screenshots)
```

## Quick start (cote client)

```bash
docker run -d \
  --name prod-watch-runner \
  --restart unless-stopped \
  -e RUNNER_TOKEN=pwr_<slug>_<hex> \
  ghcr.io/salutcava/prod-watch-runner:latest
```

Le token est fourni par l'equipe Prod Watch a la signature du contrat Scale / Enterprise.

## Build (cote Prod Watch)

```bash
GITHUB_TOKEN=ghp_xxx ./build.sh [tag]
```

Le build est multi-stage :
1. **Builder** : clone le repo prive `qa-saas` et bundle + minifie en 1 fichier `qa-saas/runner.cjs` via esbuild.
2. **Runtime** : copie uniquement le bundle minifie + le code du runner. Le code source en clair de `qa-saas` n'apparait JAMAIS dans l'image finale.

Le `GITHUB_TOKEN` est utilise UNIQUEMENT pendant le stage builder pour cloner `qa-saas` ; il n'est pas persiste dans l'image. En CI (GitHub Actions), il est stocke comme secret `QA_SAAS_PULL_TOKEN`.

## Variables d'environnement

| Variable | Default | Role |
|---|---|---|
| `RUNNER_TOKEN` | (obligatoire) | Token d'identification du runner, format `pwr_<slug>_<64hex>` |
| `PROD_WATCH_URL` | `https://app.prod-watch.com` | URL du dashboard Prod Watch |
| `POLL_INTERVAL_MS` | `10000` | Intervalle de poll des nouveaux jobs (ms) |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Intervalle de heartbeat (ms) |
| `QA_SAAS_PATH` | `/app/qa-saas` | Path interne du bundle qa-saas |
| `QA_SAAS_ENTRY` | `/app/qa-saas/runner.cjs` | Entry point du bundle qa-saas |

## Codes de sortie

| Code | Sens |
|---|---|
| `0` | Arret propre (SIGTERM / SIGINT) |
| `1` | Erreur fatale dans la boucle principale |
| `2` | Configuration invalide (RUNNER_TOKEN absent ou format invalide) |
| `3` | Token revoque ou invalide cote dashboard (401 sur heartbeat/poll) |

Le client doit `docker restart prod-watch-runner` apres avoir reconfigure un nouveau token en cas d'exit 3.

## Logs

Les logs sortent en JSON structure sur stdout (format Filebeat / Loki / Splunk compatible).

```json
{"ts":"2026-05-19T00:30:00Z","level":"info","msg":"Job recu","slug":"acme","jobId":42}
```

Visualisation : `docker logs prod-watch-runner` ou bind sur un agent log d'entreprise.

## Securite

Cf. https://app.prod-watch.com/security

- Auth : Bearer token Bearer unique par container, revocable a tout moment
- Pas d'inbound network (le runner fait du sortant uniquement)
- Credentials de tests : pull on-demand depuis le dashboard, jamais persistes sur disque
- Code source qa-saas : bundle + minifie + obfusque (variables renommees), pas en clair
- Image publiee sur GitHub Container Registry (privee par defaut)

## Licence

UNLICENSED - propriete de LAMSTER (Prod Watch). Reservation des droits par LAMSTER.
