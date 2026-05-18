/**
 * Boucle principale du runner self-hosted Prod Watch.
 *
 * Cycle de vie :
 *   - Heartbeat toutes les 30s (signale qu'on est vivant)
 *   - Poll toutes les 10s : recupere le prochain job, l'execute, push les
 *     resultats. Tant qu'il y a des jobs en queue, le runner les enchaine
 *     sans attendre l'intervalle de poll.
 *
 * Variables d'env :
 *   - RUNNER_TOKEN (obligatoire) : token pwr_<slug>_<64hex>
 *   - PROD_WATCH_URL (default: https://app.prod-watch.com)
 *   - POLL_INTERVAL_MS (default: 10000)
 *   - HEARTBEAT_INTERVAL_MS (default: 30000)
 *
 * Arret :
 *   - SIGTERM/SIGINT : graceful shutdown apres le job en cours
 *   - 401 sur heartbeat ou poll : exit 3 (token revoque)
 *   - Erreur critique : exit 1
 */
import { readRunnerToken, readDashboardUrl } from "./auth.mjs";
import { sendHeartbeat, pollNextJob, pushRunResults } from "./api.mjs";
import { executeJob } from "./executor.mjs";
import { logger } from "./logger.mjs";

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "10000", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "30000", 10);

let shuttingDown = false;
let currentJobId = null;

process.on("SIGTERM", () => {
  logger.info("SIGTERM recu - arret apres job en cours");
  shuttingDown = true;
});
process.on("SIGINT", () => {
  logger.info("SIGINT recu - arret apres job en cours");
  shuttingDown = true;
});

async function main() {
  const token = readRunnerToken();
  const dashboardUrl = readDashboardUrl();
  logger.info(`Prod Watch Runner demarre`, {
    dashboardUrl,
    pollIntervalMs: POLL_INTERVAL_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });

  // Heartbeat initial pour signaler immediatement la presence du runner
  // (sinon il faut attendre 30s avant que findActiveRunnerForClient remonte
  // ce runner cote dashboard).
  await sendHeartbeat({ dashboardUrl, token });

  // Heartbeat periodique (setInterval, separe de la boucle poll)
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat({ dashboardUrl, token }).catch((err) => {
      logger.warn("Heartbeat exception (non bloquant)", { error: String(err) });
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Boucle poll : pas un setInterval fixe (sinon plusieurs polls peuvent se
  // chevaucher si un job prend > poll_interval). On chaine sleep + poll en
  // sequence.
  while (!shuttingDown) {
    let job;
    try {
      job = await pollNextJob({ dashboardUrl, token });
    } catch (err) {
      logger.warn("Poll exception (retry implicite via boucle)", { error: String(err) });
      job = null;
    }

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    currentJobId = job.jobId;
    logger.info(`Job recu : ${job.slug}/${job.product || "default"} (id=${job.jobId})`, {
      scenario: job.scenario,
      runLabel: job.runLabel,
    });

    let payload;
    try {
      payload = await executeJob(job);
    } catch (err) {
      logger.error("Execute job a leve une exception non recuperee", { error: String(err) });
      payload = {
        slug: job.slug,
        status: "fail",
        passed: 0, failed: 0, total: 0,
        scenarios: job.scenario || "",
        trigger_type: job.triggerType || "manual",
        product: job.product || null,
        environment: job.environment || null,
        exit_code: -1,
        crash_log_tail: String(err).slice(0, 16384),
        triggered_by: "runner-self-hosted",
      };
    }

    const pushResult = await pushRunResults({ dashboardUrl, token, payload });
    if (pushResult.ok) {
      logger.info(`Job ${job.jobId} termine + push OK`, {
        runId: pushResult.runId,
        status: payload.status,
        passed: payload.passed,
        failed: payload.failed,
      });
    } else {
      logger.error(`Job ${job.jobId} : push KO`, { status: pushResult.status });
      // TODO V2 : persister le payload en local et retry plus tard.
    }
    currentJobId = null;

    // Pas de sleep : on enchaine le prochain poll immediatement tant qu'il y
    // a peut-etre encore des jobs en queue.
  }

  clearInterval(heartbeatTimer);
  logger.info("Runner arrete proprement");
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error("Erreur fatale dans la boucle principale", { error: String(err) });
  process.exit(1);
});
