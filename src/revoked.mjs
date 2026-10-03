/**
 * Veille du runner quand son jeton est refuse (401 sur heartbeat ou poll).
 *
 * Avant (jusqu'a v0.2.3) : le runner quittait en exit 3. Avec
 * --restart unless-stopped, Docker le relancait chaque minute et le runner
 * se faisait refuser a chaque fois, sans fin (conteneur de test du
 * 03/10/2026 : plus de 109 000 relances en quatre mois, une requete refusee
 * par minute contre le dashboard).
 *
 * Maintenant : le runner reste en vie, ne demande plus de jobs, et renvoie
 * un heartbeat toutes les REVOKED_RECHECK_MS (15 min par defaut). Un refus
 * passager (incident cote dashboard) se resorbe seul : le runner reprend des
 * que le jeton est de nouveau accepte. Une revocation est definitive cote
 * dashboard (revoked_at) : il faut un nouveau jeton et relancer le conteneur
 * avec le nouveau RUNNER_TOKEN.
 */

export function revokedRecheckMs() {
  return parseInt(process.env.REVOKED_RECHECK_MS || "900000", 10);
}

/**
 * Attend que le jeton soit de nouveau accepte, ou que l'arret soit demande.
 *
 * Le sommeil est decoupe en tranches de `tickMs` pour deux raisons : un
 * SIGTERM (docker stop, 10 s de grace) est honore sans attendre la fin des
 * 15 minutes, et `touch` est appele a chaque tranche pour que le HEALTHCHECK
 * ne marque pas le conteneur unhealthy (ce qui ferait relancer le conteneur
 * par un outil d'autoheal et recreerait la boucle).
 *
 * @returns {Promise<boolean>} true si le jeton est accepte, false si arret.
 */
export async function waitForTokenAccepted({
  sendHeartbeat,
  isShuttingDown,
  sleep,
  touch = async () => {},
  intervalMs = revokedRecheckMs(),
  tickMs = 1000,
}) {
  while (!isShuttingDown()) {
    let waited = 0;
    while (waited < intervalMs) {
      if (isShuttingDown()) return false;
      const step = Math.min(tickMs, intervalMs - waited);
      await sleep(step);
      waited += step;
      await touch();
    }
    if (isShuttingDown()) return false;
    const result = await sendHeartbeat();
    if (result && result.ok) return true;
  }
  return false;
}
