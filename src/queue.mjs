/**
 * Queue locale persistante pour les payloads push-run que le dashboard n'a
 * pas accepte. Permet de ne pas perdre un job qui a tourne 10 minutes
 * lorsque la connexion vers le dashboard est temporairement coupee.
 *
 * Strategie :
 *   - 1 fichier JSON par payload, nom = {ts}-{slug}-{jobId}.json (tri FIFO
 *     naturel par ordre alphabetique).
 *   - Au debut de chaque iteration de poll, on rejoue les payloads en attente.
 *     Si le replay reussit, on supprime le fichier. Si le replay echoue, on
 *     break la boucle de replay (pas la peine d'en tenter d'autres si le
 *     dashboard est down) et on retentera a la prochaine iteration.
 *   - Cap a QUEUE_MAX_SIZE pour ne pas remplir le disque en cas d'incident
 *     long. Au-dela, on drop le nouveau payload avec un log d'erreur
 *     explicite : la donnee est perdue, mais le runner ne tombe pas.
 *
 * Persistance entre redemarrages du container : par defaut le dossier vit
 * dans /tmp (donc perdu au `docker rm`). Pour survivre aux redemarrages,
 * monter un volume : `-v /var/lib/runner-queue:/var/lib/runner-queue
 *  -e RUNNER_QUEUE_DIR=/var/lib/runner-queue`.
 */
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.mjs";

export function queueDir() {
  return process.env.RUNNER_QUEUE_DIR || "/tmp/runner-queue";
}

export function queueMaxSize() {
  return parseInt(process.env.RUNNER_QUEUE_MAX_SIZE || "100", 10);
}

async function ensureDir() {
  await mkdir(queueDir(), { recursive: true });
}

function sanitizeForFilename(s) {
  return String(s || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

/**
 * Ecrit un payload dans la queue. Retourne le filename cree, ou null si la
 * queue est pleine (le payload est alors perdu, mais on logge un error).
 */
export async function enqueuePayload(payload, now = Date.now()) {
  try {
    await ensureDir();
    const existing = await readdir(queueDir());
    if (existing.length >= queueMaxSize()) {
      logger.error(
        `Queue locale pleine (${existing.length} / ${queueMaxSize()}) - payload droppe`,
        { slug: payload.slug, exit_code: payload.exit_code }
      );
      return null;
    }
    const slug = sanitizeForFilename(payload.slug);
    const jobId = sanitizeForFilename(payload.job_id || payload.jobId || "nojob");
    const filename = `${now}-${slug}-${jobId}.json`;
    const fullPath = join(queueDir(), filename);
    await writeFile(fullPath, JSON.stringify({ payload, queuedAt: now }, null, 2));
    logger.warn(`Push KO -> payload mis en file locale`, { file: filename, slug: payload.slug });
    return filename;
  } catch (err) {
    logger.error("Impossible d'ecrire dans la queue locale (FS non writable ?)", {
      error: String(err),
    });
    return null;
  }
}

/**
 * Retourne la liste triee (FIFO) des fichiers en attente. Best-effort :
 * si le dossier n'existe pas, retourne tableau vide.
 */
export async function listPendingPayloads() {
  try {
    const files = await readdir(queueDir());
    return files.filter((f) => f.endsWith(".json")).sort();
  } catch (_) {
    return [];
  }
}

export async function readPendingPayload(filename) {
  const text = await readFile(join(queueDir(), filename), "utf8");
  return JSON.parse(text);
}

export async function removePendingPayload(filename) {
  try {
    await unlink(join(queueDir(), filename));
  } catch (_) {
    // Best-effort : si le fichier a deja ete supprime par un autre process,
    // on s'en fout.
  }
}

/**
 * Tente de rejouer tous les payloads en attente via pushFn. Stoppe au premier
 * echec (inutile d'en tenter d'autres si le dashboard est down) et garde les
 * payloads restants pour la prochaine iteration.
 *
 * @param {(payload: object) => Promise<{ ok: boolean }>} pushFn
 * @returns {Promise<{ replayed: number, remaining: number }>}
 */
export async function replayPendingPayloads(pushFn) {
  const pending = await listPendingPayloads();
  if (pending.length === 0) return { replayed: 0, remaining: 0 };

  logger.info(`Replay queue locale : ${pending.length} payload(s) en attente`);
  let replayed = 0;
  for (const filename of pending) {
    let entry;
    try {
      entry = await readPendingPayload(filename);
    } catch (err) {
      logger.error(`Payload en queue illisible, suppression`, {
        file: filename, error: String(err),
      });
      await removePendingPayload(filename);
      continue;
    }
    const result = await pushFn(entry.payload);
    if (result && result.ok) {
      await removePendingPayload(filename);
      replayed += 1;
      logger.info(`Replay OK - payload ${filename} pousse au dashboard`);
    } else {
      logger.warn(`Replay KO - dashboard toujours injoignable, on reprend plus tard`, {
        file: filename, status: result && result.status,
      });
      break;
    }
  }
  const remaining = pending.length - replayed;
  return { replayed, remaining };
}
