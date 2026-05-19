/**
 * Lecture + validation du RUNNER_TOKEN depuis l'environnement.
 */
import { logger } from "./logger.mjs";

const TOKEN_RE = /^pwr_[a-z0-9][a-z0-9_-]*_[0-9a-f]{64}$/;

export function readRunnerToken() {
  const token = (process.env.RUNNER_TOKEN || "").trim();
  if (!token) {
    logger.error("RUNNER_TOKEN env var manquante - le runner ne peut pas demarrer");
    process.exit(2);
  }
  if (!TOKEN_RE.test(token)) {
    logger.error("RUNNER_TOKEN format invalide (attendu : pwr_<slug>_<64hex>)");
    process.exit(2);
  }
  return token;
}

export function readDashboardUrl() {
  let url = (process.env.PROD_WATCH_URL || "https://app.prod-watch.com").trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    logger.error(`PROD_WATCH_URL doit commencer par http(s):// (recu: ${url})`);
    process.exit(2);
  }
  // Supprime le slash final pour eviter les double-slash dans les URLs.
  return url.replace(/\/+$/, "");
}

export function buildAuthHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": `prod-watch-runner/${process.env.npm_package_version || "0.1.0"}`,
  };
}

/**
 * Extrait le slug client depuis le token (format pwr_<slug>_<64hex>). Utilise
 * par l'executor pour valider que le payload du job recu via /api/runner/poll
 * appartient bien au slug du token : defense en profondeur contre une faute
 * cote dashboard qui ferait fuiter les configs/scenarios d'un autre client.
 *
 * Retourne null si le token n'a pas le format attendu (le caller a deja
 * valide via readRunnerToken au demarrage, donc en pratique ne retourne
 * null que si on appelle avec un token brut non valide).
 */
export function extractSlugFromToken(token) {
  if (!token || typeof token !== "string") return null;
  const m = token.match(/^pwr_([a-z0-9][a-z0-9_-]*)_[0-9a-f]{64}$/);
  return m ? m[1] : null;
}
