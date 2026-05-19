/**
 * Tests du module health (fichier de fraicheur lu par HEALTHCHECK Docker).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchHealth, readHealthAge, healthFile, healthStaleMs } from "../src/health.mjs";

let workDir;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "runner-health-"));
  process.env.RUNNER_HEALTH_FILE = join(workDir, "runner.health");
  delete process.env.RUNNER_HEALTH_STALE_MS;
});

afterEach(async () => {
  delete process.env.RUNNER_HEALTH_FILE;
  delete process.env.RUNNER_HEALTH_STALE_MS;
  try { await rm(workDir, { recursive: true, force: true }); } catch (_) {}
});

describe("healthFile / healthStaleMs", () => {
  it("retourne le path par defaut si env vide", () => {
    delete process.env.RUNNER_HEALTH_FILE;
    expect(healthFile()).toBe("/tmp/runner.health");
  });

  it("respecte RUNNER_HEALTH_FILE", () => {
    process.env.RUNNER_HEALTH_FILE = "/custom/path.health";
    expect(healthFile()).toBe("/custom/path.health");
  });

  it("retourne 90s par defaut", () => {
    expect(healthStaleMs()).toBe(90000);
  });

  it("respecte RUNNER_HEALTH_STALE_MS", () => {
    process.env.RUNNER_HEALTH_STALE_MS = "30000";
    expect(healthStaleMs()).toBe(30000);
  });
});

describe("touchHealth", () => {
  it("ecrit le timestamp courant dans le fichier", async () => {
    const before = Date.now();
    await touchHealth();
    const after = Date.now();

    const content = await readFile(healthFile(), "utf8");
    const written = parseInt(content, 10);
    expect(written).toBeGreaterThanOrEqual(before);
    expect(written).toBeLessThanOrEqual(after);
  });

  it("accepte un timestamp explicite", async () => {
    await touchHealth(1234567890);
    const content = await readFile(healthFile(), "utf8");
    expect(content).toBe("1234567890");
  });

  it("n'echoue pas si le fichier ne peut pas etre ecrit", async () => {
    process.env.RUNNER_HEALTH_FILE = "/proc/this-path-cannot-be-written";
    await expect(touchHealth()).resolves.toBeUndefined();
  });
});

describe("readHealthAge", () => {
  it("retourne l'age en ms par rapport au timestamp ecrit", async () => {
    await writeFile(healthFile(), "1000");
    const age = await readHealthAge(5000);
    expect(age).toBe(4000);
  });

  it("throw si le fichier n'existe pas", async () => {
    await expect(readHealthAge()).rejects.toThrow();
  });

  it("throw si le contenu n'est pas un nombre", async () => {
    await writeFile(healthFile(), "pas-un-nombre");
    await expect(readHealthAge()).rejects.toThrow(/invalide/);
  });
});
