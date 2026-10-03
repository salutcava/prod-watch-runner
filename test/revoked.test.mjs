/**
 * Tests de la veille sur jeton refuse (waitForTokenAccepted).
 * Le sommeil est injecte : on compte le temps simule au lieu d'attendre.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForTokenAccepted, revokedRecheckMs } from "../src/revoked.mjs";

function fakeClock() {
  const clock = { elapsed: 0 };
  clock.sleep = vi.fn(async (ms) => { clock.elapsed += ms; });
  return clock;
}

describe("waitForTokenAccepted", () => {
  afterEach(() => { delete process.env.REVOKED_RECHECK_MS; });

  it("ne renvoie un heartbeat qu'une fois l'intervalle ecoule, puis reprend des qu'il est accepte", async () => {
    const clock = fakeClock();
    const callsAt = [];
    const sendHeartbeat = vi.fn(async () => {
      callsAt.push(clock.elapsed);
      return callsAt.length < 3 ? { ok: false, revoked: true } : { ok: true };
    });
    const accepted = await waitForTokenAccepted({
      sendHeartbeat, isShuttingDown: () => false, sleep: clock.sleep,
      intervalMs: 900_000, tickMs: 1000,
    });
    expect(accepted).toBe(true);
    // Trois verifications espacees de 15 min, aucune avant la premiere echeance.
    expect(callsAt).toEqual([900_000, 1_800_000, 2_700_000]);
  });

  it("garde le HEALTHCHECK frais pendant la veille", async () => {
    const clock = fakeClock();
    const touch = vi.fn(async () => {});
    await waitForTokenAccepted({
      sendHeartbeat: async () => ({ ok: true }), isShuttingDown: () => false,
      sleep: clock.sleep, touch, intervalMs: 10_000, tickMs: 1000,
    });
    expect(touch).toHaveBeenCalledTimes(10);
  });

  it("honore un arret demande en cours de veille sans attendre l'intervalle", async () => {
    const clock = fakeClock();
    const sendHeartbeat = vi.fn(async () => ({ ok: false, revoked: true }));
    const accepted = await waitForTokenAccepted({
      sendHeartbeat, isShuttingDown: () => clock.elapsed >= 5000,
      sleep: clock.sleep, intervalMs: 900_000, tickMs: 1000,
    });
    expect(accepted).toBe(false);
    expect(sendHeartbeat).not.toHaveBeenCalled();
    expect(clock.elapsed).toBe(5000);
  });

  it("intervalle par defaut de 15 minutes, surchargeable par REVOKED_RECHECK_MS", () => {
    expect(revokedRecheckMs()).toBe(900_000);
    process.env.REVOKED_RECHECK_MS = "60000";
    expect(revokedRecheckMs()).toBe(60_000);
  });
});
