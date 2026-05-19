/**
 * Tests des helpers d'auth (lecture env vars + format token).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("buildAuthHeaders", () => {
  it("retourne Authorization + Content-Type", async () => {
    const { buildAuthHeaders } = await import("../src/auth.mjs");
    const headers = buildAuthHeaders("pwr_acme_" + "a".repeat(64));
    expect(headers.Authorization).toContain("Bearer pwr_acme_");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toContain("prod-watch-runner");
  });
});

describe("readRunnerToken", () => {
  const originalEnv = process.env.RUNNER_TOKEN;
  const originalExit = process.exit;

  afterEach(() => {
    process.env.RUNNER_TOKEN = originalEnv;
    process.exit = originalExit;
  });

  it("accepte un token au format valide", async () => {
    process.env.RUNNER_TOKEN = "pwr_acme-test_" + "a".repeat(64);
    const { readRunnerToken } = await import("../src/auth.mjs");
    expect(readRunnerToken()).toBe(process.env.RUNNER_TOKEN);
  });

  it("exit 2 si RUNNER_TOKEN manquant", async () => {
    delete process.env.RUNNER_TOKEN;
    process.exit = vi.fn();
    const { readRunnerToken } = await import("../src/auth.mjs");
    readRunnerToken();
    expect(process.exit).toHaveBeenCalledWith(2);
  });

  it("exit 2 si format invalide", async () => {
    process.env.RUNNER_TOKEN = "not-a-valid-token";
    process.exit = vi.fn();
    const { readRunnerToken } = await import("../src/auth.mjs");
    readRunnerToken();
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});

describe("extractSlugFromToken", () => {
  it("extrait le slug d'un token valide", async () => {
    const { extractSlugFromToken } = await import("../src/auth.mjs");
    expect(extractSlugFromToken("pwr_acme_" + "a".repeat(64))).toBe("acme");
    expect(extractSlugFromToken("pwr_acme-test_" + "a".repeat(64))).toBe("acme-test");
    expect(extractSlugFromToken("pwr_a1b2c3_" + "f".repeat(64))).toBe("a1b2c3");
  });

  it("retourne null sur un token mal forme", async () => {
    const { extractSlugFromToken } = await import("../src/auth.mjs");
    expect(extractSlugFromToken("")).toBeNull();
    expect(extractSlugFromToken(null)).toBeNull();
    expect(extractSlugFromToken("not-a-token")).toBeNull();
    expect(extractSlugFromToken("pwr_acme_short")).toBeNull();
    expect(extractSlugFromToken("pwr__" + "a".repeat(64))).toBeNull(); // slug vide
  });
});

describe("readDashboardUrl", () => {
  const originalEnv = process.env.PROD_WATCH_URL;
  const originalExit = process.exit;

  afterEach(() => {
    process.env.PROD_WATCH_URL = originalEnv;
    process.exit = originalExit;
  });

  it("retourne la valeur par defaut si pas defini", async () => {
    delete process.env.PROD_WATCH_URL;
    const { readDashboardUrl } = await import("../src/auth.mjs");
    expect(readDashboardUrl()).toBe("https://app.prod-watch.com");
  });

  it("supprime le trailing slash", async () => {
    process.env.PROD_WATCH_URL = "https://example.com/";
    const { readDashboardUrl } = await import("../src/auth.mjs");
    expect(readDashboardUrl()).toBe("https://example.com");
  });

  it("exit 2 si URL ne commence pas par http", async () => {
    process.env.PROD_WATCH_URL = "example.com";
    process.exit = vi.fn();
    const { readDashboardUrl } = await import("../src/auth.mjs");
    readDashboardUrl();
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
