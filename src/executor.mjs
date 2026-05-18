/**
 * Execute qa-saas pour un job donne et retourne le payload format push-run.
 *
 * qa-saas est embarque dans l'image Docker sous /app/qa-saas (cf. Dockerfile
 * multi-stage qui le bundle/minifie). On l'invoque via `node` avec les variables
 * d'environnement attendues par qa-saas/scripts/runner-cli.js.
 *
 * Retourne le payload pret pour POST /api/admin/push-run, ou un payload "crash"
 * si qa-saas plante (exit != 0).
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "./logger.mjs";

const QA_SAAS_PATH = process.env.QA_SAAS_PATH || "/app/qa-saas";
const QA_SAAS_ENTRY = process.env.QA_SAAS_ENTRY || `${QA_SAAS_PATH}/runner.cjs`;

/**
 * @param {{ jobId, slug, product, environment, scenario, runLabel, triggerType,
 *           triggeredByLabel, payload }} job
 * @returns {Promise<object>} payload pret pour push-run
 */
export async function executeJob(job) {
  const startedAt = Date.now();
  const runOutputDir = join(tmpdir(), `qa-run-${job.slug}-${Date.now()}`);
  await mkdir(runOutputDir, { recursive: true });

  // Env vars consumees par qa-saas/scripts/runner-cli.js. Cf. interface CLI
  // documentee dans qa-saas/scripts/run.sh.
  const env = {
    ...process.env,
    CLIENT: job.slug,
    PRODUCT: job.product || "main",
    ENVIRONMENT: job.environment || "prod",
    SCENARIO: job.scenario || "",
    RUN_LABEL: job.runLabel || "",
    TRIGGER_TYPE: job.triggerType || "manual",
    RUN_OUTPUT_DIR: runOutputDir,
    // Forcing pas de push interne : qa-saas a sa propre logique push-run qui
    // utilise WEBHOOK_SECRET. Nous on push manuellement avec runner Bearer.
    SKIP_PUSH: "1",
  };

  let stdout = "";
  let stderr = "";
  let exitCode;

  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn("node", [QA_SAAS_ENTRY], {
        env,
        cwd: QA_SAAS_PATH,
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

  // qa-saas ecrit un fichier results.json dans RUN_OUTPUT_DIR avec le summary
  // (passed/failed/total/scenarios). Si non present (crash), on construit un
  // payload "crash" avec stdout/stderr en log_tail.
  let results = null;
  try {
    const text = await readFile(join(runOutputDir, "results.json"), "utf8");
    results = JSON.parse(text);
  } catch (_) {
    results = null;
  }

  // Cleanup best-effort
  try { await rm(runOutputDir, { recursive: true, force: true }); } catch (_) {}

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
