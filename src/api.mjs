/**
 * Wrappers HTTP autour de l'API Prod Watch (heartbeat, poll, push-run).
 * Retry exponentiel + jitter sur les erreurs reseau / 5xx / 429, pour
 * resister aux split reseau temporaires (cas typique : VPN intermittent) et
 * eviter un thundering herd post-incident quand plusieurs runners se
 * reconnectent en meme seconde.
 */
import { buildAuthHeaders } from "./auth.mjs";
import { logger } from "./logger.mjs";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const RETRY_JITTER_RATIO = 0.25;

function jitteredDelay(baseDelay) {
  // Jitter +/- 25% : disperse les retries sur ~500ms autour du delay theorique
  // pour que N runners qui ratent leur heartbeat ne reviennent pas tous a la
  // meme milliseconde sur un dashboard qui sort d'incident.
  const jitter = baseDelay * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(baseDelay + jitter));
}

function parseRetryAfter(res) {
  // Si le serveur renvoie Retry-After (RFC 7231), on l'honore : il sait mieux
  // que nous quand revenir (rate limit, throttling). On supporte uniquement
  // le format delta-seconds (le format HTTP-date est tres rare en pratique).
  if (!res || !res.headers || typeof res.headers.get !== "function") return null;
  const raw = res.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function fetchWithRetry(url, opts, { retries = MAX_RETRIES, label = "fetch" } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfterMs = null;
    try {
      const res = await fetch(url, opts);
      // Erreurs non-retry : 4xx (autres que 429). Le caller decide quoi faire
      // d'une 401 (token revoque) ou 403 (pas autorise).
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
      retryAfterMs = parseRetryAfter(res);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) {
      const exp = RETRY_BASE_MS * Math.pow(2, attempt);
      const delay = retryAfterMs != null ? retryAfterMs : jitteredDelay(exp);
      logger.warn(`${label} attempt ${attempt + 1} failed, retry in ${delay}ms`, { error: String(lastError) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function sendHeartbeat({ dashboardUrl, token }) {
  let res;
  try {
    res = await fetchWithRetry(
      `${dashboardUrl}/api/runner/heartbeat`,
      { method: "POST", headers: buildAuthHeaders(token), body: "{}" },
      { label: "heartbeat" }
    );
  } catch (err) {
    // Tous les retries ont echoue (reseau down, dashboard unreachable, etc.).
    // On ne crash pas la boucle : le caller decide quoi faire de cet echec
    // (logger un warn, compter les echecs consecutifs, etc.).
    return { ok: false, error: String(err) };
  }
  if (res.status === 401) {
    logger.error("Runner token revoke ou invalide. Arret du runner.");
    process.exit(3);
  }
  if (!res.ok) {
    logger.warn(`Heartbeat HTTP ${res.status}`);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

export async function pollNextJob({ dashboardUrl, token }) {
  const res = await fetchWithRetry(
    `${dashboardUrl}/api/runner/poll`,
    { method: "POST", headers: buildAuthHeaders(token), body: "{}" },
    { label: "poll" }
  );
  if (res.status === 401) {
    logger.error("Runner token revoke ou invalide. Arret du runner.");
    process.exit(3);
  }
  if (res.status === 204) return null; // aucun job
  if (!res.ok) {
    logger.warn(`Poll HTTP ${res.status}`);
    return null;
  }
  const body = await res.json().catch(() => null);
  return body && body.job ? body.job : null;
}

export async function pushRunResults({ dashboardUrl, token, payload }) {
  const res = await fetchWithRetry(
    `${dashboardUrl}/api/admin/push-run`,
    {
      method: "POST",
      headers: buildAuthHeaders(token),
      body: JSON.stringify(payload),
    },
    { label: "push-run" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error(`push-run HTTP ${res.status}`, { detail: text.slice(0, 500) });
    return { ok: false, status: res.status };
  }
  const body = await res.json().catch(() => null);
  return { ok: true, runId: body && body.id, hash: body && body.hash };
}
