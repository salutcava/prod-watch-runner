/**
 * Tests des wrappers HTTP (sendHeartbeat, pollNextJob, pushRunResults).
 * Mock global de fetch pour simuler les reponses du dashboard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendHeartbeat, pollNextJob, pushRunResults } from "../src/api.mjs";

const URL = "https://test.prod-watch.com";
const TOKEN = "pwr_test_" + "a".repeat(64);

let originalFetch;
let originalExit;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalExit = process.exit;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
});

describe("sendHeartbeat", () => {
  it("POST /api/runner/heartbeat avec Bearer", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "",
    });
    await sendHeartbeat({ dashboardUrl: URL, token: TOKEN });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [calledUrl, opts] = globalThis.fetch.mock.calls[0];
    expect(calledUrl).toBe(`${URL}/api/runner/heartbeat`);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("exit 3 si 401 (token revoque)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({}), text: async () => "",
    });
    process.exit = vi.fn();
    await sendHeartbeat({ dashboardUrl: URL, token: TOKEN });
    expect(process.exit).toHaveBeenCalledWith(3);
  });
});

describe("pollNextJob", () => {
  it("retourne null si 204", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 204, json: async () => ({}), text: async () => "",
    });
    const job = await pollNextJob({ dashboardUrl: URL, token: TOKEN });
    expect(job).toBeNull();
  });

  it("retourne le job si 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ job: { jobId: 42, slug: "acme", scenario: "login" } }),
      text: async () => "",
    });
    const job = await pollNextJob({ dashboardUrl: URL, token: TOKEN });
    expect(job).toEqual({ jobId: 42, slug: "acme", scenario: "login" });
  });

  it("exit 3 si 401", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({}), text: async () => "",
    });
    process.exit = vi.fn();
    await pollNextJob({ dashboardUrl: URL, token: TOKEN });
    expect(process.exit).toHaveBeenCalledWith(3);
  });
});

describe("pushRunResults", () => {
  it("POST /api/admin/push-run et retourne { ok, runId } si 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 100, hash: "abc" }),
      text: async () => "",
    });
    const result = await pushRunResults({
      dashboardUrl: URL,
      token: TOKEN,
      payload: { slug: "acme", status: "pass", passed: 2, failed: 0, total: 2 },
    });
    expect(result.ok).toBe(true);
    expect(result.runId).toBe(100);
    expect(result.hash).toBe("abc");

    const [calledUrl, opts] = globalThis.fetch.mock.calls[0];
    expect(calledUrl).toBe(`${URL}/api/admin/push-run`);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(opts.body).status).toBe("pass");
  });

  it("retourne ok=false si 4xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({}), text: async () => "forbidden",
    });
    const result = await pushRunResults({
      dashboardUrl: URL, token: TOKEN, payload: { slug: "x" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});
