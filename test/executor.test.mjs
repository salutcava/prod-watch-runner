/**
 * Tests de l'executor : verifie l'ecriture des configs/scenarios temp, le
 * cleanup defensif et la validation slug.
 *
 * On NE TESTE PAS le spawn Playwright reel (out of scope unit test : ce serait
 * un test integration avec Playwright + Chromium). On mock l'entry-point qa-saas
 * via une env var QA_SAAS_ENTRY pointant vers un script de test qui simule
 * differents scenarios (succes, crash, results.json absent).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir;
let originalQaSaasPath;
let originalQaSaasEntry;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "runner-executor-test-"));
  mkdirSync(join(workDir, "configs"), { recursive: true });
  mkdirSync(join(workDir, "scenarios"), { recursive: true });
  originalQaSaasPath = process.env.QA_SAAS_PATH;
  originalQaSaasEntry = process.env.QA_SAAS_ENTRY;
  process.env.QA_SAAS_PATH = workDir;
});

afterEach(() => {
  if (originalQaSaasPath === undefined) delete process.env.QA_SAAS_PATH;
  else process.env.QA_SAAS_PATH = originalQaSaasPath;
  if (originalQaSaasEntry === undefined) delete process.env.QA_SAAS_ENTRY;
  else process.env.QA_SAAS_ENTRY = originalQaSaasEntry;
  try { rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
});

function writeFakeEntry(scriptContent) {
  const entryPath = join(workDir, "fake-entry.cjs");
  writeFileSync(entryPath, scriptContent);
  process.env.QA_SAAS_ENTRY = entryPath;
}

describe("executor.executeJob", () => {
  it("refuse le job si le slug du token ne matche pas celui du job", async () => {
    const { executeJob } = await import("../src/executor.mjs");
    const job = { jobId: 1, slug: "client-a", clientConfig: { x: 1 }, scenarios: {} };
    const payload = await executeJob(job, "client-b");
    expect(payload.status).toBe("fail");
    expect(payload.exit_code).toBe(-1);
    expect(payload.crash_log_tail).toContain("ne matche pas");
    // Aucun fichier ne doit avoir ete ecrit
    expect(readdirSync(join(workDir, "configs"))).toEqual([]);
    expect(readdirSync(join(workDir, "scenarios"))).toEqual([]);
  });

  it("ecrit clientConfig et scenarios dans le FS avant de spawn l'entry", async () => {
    // Fake entry qui inspecte le FS et ecrit un results.json passe
    writeFakeEntry(`
      const fs = require('fs');
      const path = require('path');
      const cfg = JSON.parse(fs.readFileSync(path.join('${workDir}', 'configs', 'acme.json'), 'utf8'));
      const sc = JSON.parse(fs.readFileSync(path.join('${workDir}', 'scenarios', 'acme-main-login.json'), 'utf8'));
      fs.writeFileSync(path.join(process.env.RUN_OUTPUT_DIR, 'results.json'),
        JSON.stringify({ passed: cfg.products ? 1 : 0, failed: 0, total: 1, scenarios: sc.name }));
    `);

    const { executeJob } = await import("../src/executor.mjs");
    const job = {
      jobId: 42,
      slug: "acme",
      product: "main",
      scenario: "acme-main-login",
      clientConfig: { products: { main: { defaultEnv: "prod" } } },
      scenarios: { "acme-main-login": { name: "Login flow" } },
    };
    const payload = await executeJob(job, "acme");
    expect(payload.status).toBe("pass");
    expect(payload.passed).toBe(1);
    expect(payload.scenarios).toBe("Login flow");
  }, 10000);

  it("cleanup defensif : les fichiers configs/scenarios sont supprimes apres le run", async () => {
    writeFakeEntry(`
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(process.env.RUN_OUTPUT_DIR, 'results.json'),
        JSON.stringify({ passed: 1, failed: 0, total: 1 }));
    `);

    const { executeJob } = await import("../src/executor.mjs");
    const job = {
      jobId: 42,
      slug: "acme",
      product: "main",
      clientConfig: { products: { main: {} } },
      scenarios: {
        "acme-main-login": { name: "Login" },
        "acme-main-dashboard": { name: "Dashboard" },
      },
    };
    await executeJob(job, "acme");
    // Les fichiers ecrits doivent avoir ete unlinks
    expect(existsSync(join(workDir, "configs", "acme.json"))).toBe(false);
    expect(existsSync(join(workDir, "scenarios", "acme-main-login.json"))).toBe(false);
    expect(existsSync(join(workDir, "scenarios", "acme-main-dashboard.json"))).toBe(false);
  }, 10000);

  it("cleanup execute meme si l'entry crash", async () => {
    writeFakeEntry(`process.exit(1);`);

    const { executeJob } = await import("../src/executor.mjs");
    const job = {
      jobId: 42,
      slug: "acme",
      clientConfig: { products: { main: {} } },
      scenarios: { "acme-main-x": { name: "X" } },
    };
    const payload = await executeJob(job, "acme");
    expect(payload.status).toBe("fail");
    expect(payload.exit_code).toBe(1);
    // Cleanup malgre le crash
    expect(existsSync(join(workDir, "configs", "acme.json"))).toBe(false);
    expect(existsSync(join(workDir, "scenarios", "acme-main-x.json"))).toBe(false);
  }, 10000);

  it("expectedSlug null : passe sans validation (back-compat avec ancien caller)", async () => {
    writeFakeEntry(`
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(process.env.RUN_OUTPUT_DIR, 'results.json'),
        JSON.stringify({ passed: 1, failed: 0, total: 1 }));
    `);

    const { executeJob } = await import("../src/executor.mjs");
    const job = {
      jobId: 1,
      slug: "acme",
      clientConfig: { products: { main: {} } },
      scenarios: {},
    };
    const payload = await executeJob(job, null);
    expect(payload.status).toBe("pass");
  }, 10000);

  it("payload sans clientConfig/scenarios : warn mais tente quand meme (back-compat dashboard ancien)", async () => {
    writeFakeEntry(`
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(process.env.RUN_OUTPUT_DIR, 'results.json'),
        JSON.stringify({ passed: 0, failed: 1, total: 1 }));
      process.exit(1);
    `);

    const { executeJob } = await import("../src/executor.mjs");
    const job = { jobId: 1, slug: "acme", clientConfig: null, scenarios: null };
    const payload = await executeJob(job, "acme");
    // L'entry est appele (mais on a force exit 1), donc on a un crash payload
    expect(payload.status).toBe("fail");
  }, 10000);
});
