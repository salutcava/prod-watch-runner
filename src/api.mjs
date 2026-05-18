/**
 * Wrappers HTTP autour de l'API Prod Watch (heartbeat, poll, push-run).
 * Retry exponentiel sur les erreurs reseau / 5xx, pour resister aux split
 * reseau temporaires (cas typique : VPN intermittent).
 */
import { buildAuthHeaders } from "./auth.mjs";
import { logger } from "./logger.mjs";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

async function fetchWithRetry(url, opts, { retries = MAX_RETRIES, label = "fetch" } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      // Erreurs non-retry : 4xx (autres que 429). Le caller decide quoi faire
      // d'une 401 (token revoque) ou 403 (pas autorise).
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn(`${label} attempt ${attempt + 1} failed, retry in ${delay}ms`, { error: String(lastError) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function sendHeartbeat({ dashboardUrl, token }) {
  const res = await fetchWithRetry(
    `${dashboardUrl}/api/runner/heartbeat`,
    { method: "POST", headers: buildAuthHeaders(token), body: "{}" },
    { label: "heartbeat" }
  );
  if (res.status === 401) {
    logger.error("Runner token revoke ou invalide. Arret du runner.");
    process.exit(3);
  }
  if (!res.ok) {
    logger.warn(`Heartbeat HTTP ${res.status}`);
  }
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
