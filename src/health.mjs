/**
 * Fraicheur du runner ecrite sur disque pour le HEALTHCHECK Docker.
 *
 * La boucle de poll.mjs appelle touchHealth() apres chaque iteration et apres
 * chaque tentative de heartbeat. Le HEALTHCHECK Docker lit ce fichier et marque
 * le container unhealthy si l'age depasse healthStaleMs() (defaut 90s).
 *
 * Pourquoi pas pgrep / HTTP : pgrep dit juste que le process existe mais ne
 * detecte pas les deadlocks de la boucle d'evenements ; un endpoint HTTP
 * impliquerait d'ouvrir un port (le runner ne fait que du sortant par design).
 *
 * Note : on relit les env vars a chaque appel plutot que de les figer en
 * constantes au chargement du module. Ca evite les surprises si la var est
 * setee apres l'import (cas typique des tests) et c'est sans cout mesurable.
 */
import { writeFile, readFile } from "node:fs/promises";

export function healthFile() {
  return process.env.RUNNER_HEALTH_FILE || "/tmp/runner.health";
}

export function healthStaleMs() {
  return parseInt(process.env.RUNNER_HEALTH_STALE_MS || "90000", 10);
}

export async function touchHealth(now = Date.now()) {
  try {
    await writeFile(healthFile(), String(now));
  } catch (_) {
    // FS readonly ou /tmp non writable : on ignore plutot que crasher la boucle.
    // Le HEALTHCHECK marquera unhealthy de lui-meme si le fichier reste vide.
  }
}

export async function readHealthAge(now = Date.now()) {
  const raw = await readFile(healthFile(), "utf8");
  const ts = parseInt(raw.trim(), 10);
  if (!Number.isFinite(ts)) {
    throw new Error(`health file contient une valeur invalide : ${raw.slice(0, 32)}`);
  }
  return now - ts;
}
