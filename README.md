# Prod Watch Runner

Container Docker qui exécute les tests Playwright Prod Watch sur votre propre infrastructure (plan Scale / Enterprise).

Utile si vos environnements de recette / preprod sont **derrière un VPN, un firewall ou un réseau interne** et ne sont pas accessibles depuis l'extérieur. Le runner tourne chez vous, accède aux URLs internes, et remonte uniquement les résultats vers le dashboard Prod Watch via HTTPS sortant.

## Pourquoi installer ce runner

- **Vos données ne quittent pas votre réseau** : les credentials de test, les captures d'écran et les vidéos restent sur votre infrastructure jusqu'à ce que le runner pousse les résultats finaux.
- **Connexion sortante uniquement** : aucun port à ouvrir en entrée, le runner se connecte au dashboard, jamais l'inverse.
- **Pas de quota** : les runs exécutés par votre runner ne consomment pas le plafond de concurrence partagé du cloud Prod Watch.
- **Compatible VPN, secteur régulé** : adapté banque / santé / défense / data sensible.

## Quick start

Avant de lancer, il vous faut un `RUNNER_TOKEN`. Demandez-le à votre interlocuteur Prod Watch (ils le génèrent en 30 secondes depuis leur back-office).

```bash
docker run -d \
  --name prod-watch-runner \
  --restart unless-stopped \
  -e RUNNER_TOKEN=pwr_votreslug_xxxxxxxxxxxxxxxx \
  ghcr.io/salutcava/prod-watch-runner:latest
```

Le container est sans état : vous pouvez le supprimer et le relancer sans perdre quoi que ce soit. Toutes les configurations vivent sur le dashboard Prod Watch.

## Vérifier que ça marche

Une fois lancé, le runner ping le dashboard toutes les 30 secondes. Quelques secondes après le `docker run`, votre runner doit apparaître **vert (actif)** dans le back-office Prod Watch (fiche client > onglet "Runner self-hosted").

Si le runner reste rouge :

```bash
docker logs prod-watch-runner --tail 50
```

Les erreurs courantes (token invalide, dashboard injoignable, etc.) sont loggées en clair avec un `level: "error"`.

## Prérequis

- **Docker** version >= 20.10 (Linux, macOS ou Windows avec WSL2)
- **RAM** : 2 Go minimum, 4 Go recommandé si vous lancez plusieurs tests en parallèle
- **CPU** : 2 cores minimum
- **Réseau** : accès sortant HTTPS (port 443) vers `app.prod-watch.com` et `ghcr.io` (pour les mises à jour)
- **Architecture** : `linux/amd64` ou `linux/arm64` (Apple Silicon, Raspberry Pi, AWS Graviton...)

## Configuration

Toutes les options se passent par variable d'environnement (`-e VAR=value` dans `docker run`).

| Variable | Défaut | Rôle |
|---|---|---|
| `RUNNER_TOKEN` | (obligatoire) | Token d'identification fourni par Prod Watch, format `pwr_<slug>_<64hex>` |
| `PROD_WATCH_URL` | `https://app.prod-watch.com` | URL du dashboard. À surcharger si vous testez contre une instance de démo |
| `POLL_INTERVAL_MS` | `10000` | Intervalle de récupération des nouveaux tests à exécuter (ms) |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Intervalle d'envoi du signal "je suis vivant" (ms) |
| `RUNNER_HEALTH_FILE` | `/tmp/runner.health` | Fichier de fraîcheur lu par le `HEALTHCHECK` Docker |
| `RUNNER_HEALTH_STALE_MS` | `90000` | Au delà de ce délai sans mise à jour du fichier, le container passe `unhealthy` |
| `HEARTBEAT_FAILURE_WARN_THRESHOLD` | `3` | Nombre de heartbeats KO d'affilée avant de logger un warn explicite (utile pour diagnostiquer un dashboard inaccessible) |
| `RUNNER_QUEUE_DIR` | `/tmp/runner-queue` | Dossier de persistance des résultats de tests quand le dashboard est temporairement inaccessible. À bind-mounter sur un volume si vous voulez survivre aux `docker restart` |
| `RUNNER_QUEUE_MAX_SIZE` | `100` | Nombre maximum de payloads stockés localement. Au-delà, les nouveaux résultats sont droppés avec un log d'erreur |

## Résilience aux coupures dashboard

Si le dashboard est injoignable au moment de pousser les résultats d'un test (split réseau, déploiement en cours, etc.), le runner persiste le payload sur disque et rejoue automatiquement au prochain cycle de poll. Aucun résultat n'est perdu tant que la queue n'est pas pleine.

Pour survivre aussi à un redémarrage du container, montez un volume sur `RUNNER_QUEUE_DIR` :

```bash
docker run -d \
  --name prod-watch-runner \
  --restart unless-stopped \
  -v /var/lib/prod-watch-runner-queue:/var/lib/prod-watch-runner-queue \
  -e RUNNER_QUEUE_DIR=/var/lib/prod-watch-runner-queue \
  -e RUNNER_TOKEN=pwr_votreslug_xxxxxxxxxxxxxxxx \
  ghcr.io/salutcava/prod-watch-runner:latest
```

Sans volume, la queue vit dans `/tmp` et est perdue au `docker rm` (mais pas au `docker restart` sur le même container).

## Healthcheck Docker

Le container expose un `HEALTHCHECK` natif. La boucle de poll écrit `/tmp/runner.health` à chaque itération ; si le fichier n'est pas rafraîchi pendant plus de 90 secondes (3 heartbeats ratés), Docker passe le container `unhealthy`.

```bash
docker inspect --format='{{.State.Health.Status}}' prod-watch-runner
# healthy | unhealthy | starting
```

Branchable directement sur un orchestrateur (Swarm, Nomad, Kubernetes via livenessProbe `exec`) ou sur des outils de supervision type Portainer / Datadog Agent qui remontent l'état health Docker.

## Mettre à jour

```bash
docker pull ghcr.io/salutcava/prod-watch-runner:latest
docker stop prod-watch-runner
docker rm prod-watch-runner
docker run -d --name prod-watch-runner ... (votre commande initiale)
```

Les mises à jour sont rares et compatibles ascendant : aucune action côté configuration ne devrait être nécessaire.

## Logs

Format JSON structuré sur stdout, compatible Filebeat / Loki / Splunk / Datadog Agent.

```json
{"ts":"2026-05-19T00:30:00Z","level":"info","msg":"Job recu","slug":"acme","jobId":42}
{"ts":"2026-05-19T00:30:42Z","level":"info","msg":"Resultats pousses","status":"pass","duration_ms":42100}
```

Visualisation rapide : `docker logs -f prod-watch-runner`.

## Codes de sortie

Si le container s'arrête, le code de sortie indique pourquoi :

| Code | Sens | Action |
|---|---|---|
| `0` | Arrêt propre (SIGTERM reçu) | Aucune, c'est normal |
| `1` | Erreur fatale dans la boucle principale | Lire les logs, ouvrir un ticket support |
| `2` | `RUNNER_TOKEN` absent ou mal formaté | Vérifier la variable d'environnement |
| `3` | Token révoqué côté dashboard | Demander un nouveau token à Prod Watch et relancer |

Avec `--restart unless-stopped`, Docker redémarre automatiquement le container sur les exits `1` (transient). Les exits `2` et `3` nécessitent une intervention manuelle.

## Sécurité

- **Authentification** : Bearer token unique par container, révocable à tout moment depuis le dashboard Prod Watch.
- **Pas de port entrant** : le runner ne fait que du HTTPS sortant.
- **Credentials de tests** : transmis chiffrés à la demande au moment de l'exécution, jamais persistés sur disque dans le container.
- **Code propriétaire** : le moteur Playwright Prod Watch est packagé dans l'image sous forme de bundle minifié, pas de code source en clair.

Plus de détails : https://app.prod-watch.com/security

## Documentation complète

https://app.prod-watch.com/docs?doc=runner-self-hosted

## Support

Vous êtes client Prod Watch ? Contactez votre interlocuteur habituel ou écrivez à `support@prod-watch.com`.

## Licence

UNLICENSED - propriété de LAMSTER (Prod Watch). Tous droits réservés.
