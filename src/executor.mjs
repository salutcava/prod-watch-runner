/**
 * Execute qa-saas pour un job donne et retourne le payload format push-run.
 *
 * qa-saas est embarque dans l'image Docker sous /app/qa-saas. L'entry-point
 * est scripts/runner-execute.js (orchestrateur JS qui spawn `playwright test`,
 * cf. qa-saas/scripts/runner-execute.js).
 *
 * Le payload du job contient clientConfig + scenarios (envoyes par le dashboard
 * via /api/runner/poll) : on ecrit ces fichiers dans le filesystem du container
 * AVANT le spawn (paths attendus par engine/loader.ts cote qa-saas, qui resout
 * configs/<slug>.json et scenarios/<name>.json relativement a son __dirname).
 *
 * Securite cleanup : try/finally autour du spawn, unlink defensif des fichiers
 * ecrits a la fin. Le container peut enchainer des jobs de clients differents
 * (en theorie un container = 1 client via le token, mais on ne fait pas
 * confiance a cette invariant ; le cleanup garantit qu'aucun residu d'un job
 * ne reste accessible au job suivant).
 *
 * Retourne le payload pret pour POST /api/admin/push-run, ou un payload "crash"
 * si qa-saas plante (exit != 0).
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "./logger.mjs";

// On lit l'env paresseusement a chaque appel (pas au load du module) pour
// que les tests qui changent QA_SAAS_PATH apres l'import soient honores.
// Cout negligeable et evite les bugs de figement de constante au chargement.
function qaSaasPath() {
  return process.env.QA_SAAS_PATH || "/app/qa-saas";
}
// Entry-point JS (orchestrateur Playwright). Sous la nouvelle archi le bundle
// minifie pointe vers ce meme path : runner-execute.js reste en clair pour
// faciliter le debug client, c'est le moteur (engine/runner/utils) qui est
// bundle dans runner.bundle.cjs.
function qaSaasEntry() {
  return process.env.QA_SAAS_ENTRY || `${qaSaasPath()}/scripts/runner-execute.js`;
}

/**
 * @param {{ jobId, slug, product, environment, scenario, runLabel, triggerType,
 *           triggeredByLabel, payload, clientConfig, scenarios }} job
 * @param {string} expectedSlug - slug derive du token, doit matcher job.slug
 * @returns {Promise<object>} payload pret pour push-run
 */
export async function executeJob(job, expectedSlug = null) {
  const startedAt = Date.now();

  // Validation defense-en-profondeur : si le dashboard a fauti et nous envoie
  // un job pour un autre slug, on refuse SANS rien ecrire sur disque. Le
  // claim atomique cote dashboard est cense rendre ce cas impossible mais
  // mieux vaut un payload crash explicite qu'un fichier accidentellement
  // partage.
  if (expectedSlug && job.slug !== expectedSlug) {
    logger.error(
      `Slug mismatch : token=${expectedSlug} job=${job.slug} - job refuse`,
      { jobId: job.jobId }
    );
    return crashPayload(
      job, startedAt, -1,
      `Token slug "${expectedSlug}" ne matche pas le slug du job "${job.slug}"`,
    );
  }

  const runOutputDir = join(tmpdir(), `qa-run-${job.slug}-${Date.now()}`);
  await mkdir(runOutputDir, { recursive: true });

  const qaPath = qaSaasPath();
  const configsDir = `${qaPath}/configs`;
  const scenariosDir = `${qaPath}/scenarios`;

  // Fichiers qu'on aura ecrit (a unlink dans le finally). On les liste au fur
  // et a mesure pour le cleanup garanti meme si writeFile echoue au milieu.
  const writtenFiles = [];

  try {
    // Ecriture des configs/scenarios envoyes par le dashboard. Le moteur
    // qa-saas (engine/loader.ts) les lit depuis ces paths fixes ; on les
    // recree a chaque job parce qu'un container peut enchainer des jobs
    // (par construction du meme client, mais defense en profondeur).
    if (job.clientConfig && typeof job.clientConfig === "object") {
      await mkdir(configsDir, { recursive: true });
      const cfgPath = join(configsDir, `${job.slug}.json`);
      await writeFile(cfgPath, JSON.stringify(job.clientConfig));
      writtenFiles.push(cfgPath);
    } else {
      logger.warn(
        `Job ${job.jobId} : clientConfig absent du payload. ` +
        `Le runner ne peut pas executer sans config - le job va probablement crasher.`
      );
    }

    if (job.scenarios && typeof job.scenarios === "object") {
      await mkdir(scenariosDir, { recursive: true });
      for (const [name, content] of Object.entries(job.scenarios)) {
        const scenPath = join(scenariosDir, `${name}.json`);
        await writeFile(scenPath, JSON.stringify(content));
        writtenFiles.push(scenPath);
      }
    } else {
      logger.warn(
        `Job ${job.jobId} : scenarios absents du payload. ` +
        `Le runner ne peut pas executer sans scenarios.`
      );
    }

    // Env vars consumees par qa-saas/scripts/runner-execute.js.
    // NODE_ENV override : le bundle qa-saas contient runner/heartbeat.ts qui
    // est un HeartbeatClient interne au moteur (different du heartbeat HTTP
    // runner→dashboard). En NODE_ENV=production, il throw si
    // INTERNAL_API_URL / INTERNAL_API_TOKEN manquent (fail-safe cote cloud
    // pour ne pas perdre la trace d'un run). En contexte self-hosted, ces
    // env vars sont des secrets internes du dashboard qu'on ne veut PAS
    // exposer aux clients. On force NODE_ENV=development pour que le
    // HeartbeatClient skip silencieusement (sans throw ni warn) ; on garde
    // notre propre heartbeat HTTP /api/runner/heartbeat pour la liveness.
    // RUNNER_SELF_HOSTED=1 : marker explicite, prevu pour qu'un futur patch
    // de runner/heartbeat.ts puisse le detecter proprement.
    const env = {
      ...process.env,
      CLIENT: job.slug,
      PRODUCT: job.product || "main",
      ENVIRONMENT: job.environment || "",
      SCENARIO: job.scenario || "",
      RUN_LABEL: job.runLabel || "",
      TRIGGER_TYPE: job.triggerType || "manual",
      RUN_OUTPUT_DIR: runOutputDir,
      NODE_ENV: "development",
      RUNNER_SELF_HOSTED: "1",
    };

    let stdout = "";
    let stderr = "";
    let exitCode;

    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn("node", [qaSaasEntry()], {
          env,
          cwd: qaPath,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          if (stdout.length > 1048576) stdout = stdout.slice(-1048576); // cap 1 MB
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stderr.length > 1048576) stderr = stderr.slice(-1048576);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? -1));
      });
    } catch (err) {
      logger.error("Spawn qa-saas failed", { error: String(err) });
      return crashPayload(job, startedAt, -1, String(err));
    }

    const durationSeconds = (Date.now() - startedAt) / 1000;

    // runner-execute.js ecrit results.json dans RUN_OUTPUT_DIR avec le summary
    // (passed/failed/total/scenarios). Si non present (crash), on construit un
    // payload "crash" avec stdout/stderr en log_tail.
    let results = null;
    try {
      const text = await readFile(join(runOutputDir, "results.json"), "utf8");
      results = JSON.parse(text);
    } catch (_) {
      results = null;
    }

    if (!results || exitCode !== 0) {
      return crashPayload(job, startedAt, exitCode, stderr || stdout, durationSeconds);
    }

    return {
      slug: job.slug,
      status: results.failed > 0 ? "fail" : "pass",
      passed: results.passed || 0,
      failed: results.failed || 0,
      total: results.total || 0,
      scenarios: results.scenarios || job.scenario || "",
      report_path: results.report_path || null,
      duration_seconds: durationSeconds,
      trigger_type: job.triggerType || "manual",
      run_label: job.runLabel || null,
      triggered_by: job.triggeredByLabel || "runner-self-hosted",
      product: job.product || null,
      environment: job.environment || null,
      exit_code: exitCode,
      error_details: results.error_details || null,
    };
  } finally {
    // Cleanup garanti : unlink des fichiers ecrits (configs + scenarios) ET
    // du dossier RUN_OUTPUT_DIR. On execute meme si tout a explose au milieu
    // pour ne pas laisser de credentials residuels que le job suivant
    // pourrait lire par accident.
    for (const path of writtenFiles) {
      try { await unlink(path); } catch (_) { /* best-effort */ }
    }
    try { await rm(runOutputDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function crashPayload(job, startedAt, exitCode, logTail, durationSeconds) {
  return {
    slug: job.slug,
    status: "fail",
    passed: 0,
    failed: 0,
    total: 0,
    scenarios: job.scenario || "",
    duration_seconds: durationSeconds || (Date.now() - startedAt) / 1000,
    trigger_type: job.triggerType || "manual",
    run_label: job.runLabel || null,
    triggered_by: job.triggeredByLabel || "runner-self-hosted",
    product: job.product || null,
    environment: job.environment || null,
    exit_code: exitCode,
    crash_log_tail: String(logTail || "").slice(-16384),
  };
}
