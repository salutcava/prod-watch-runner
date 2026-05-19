/**
 * Tests de la queue locale (persistance des payloads push-run quand le
 * dashboard est injoignable).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueuePayload,
  listPendingPayloads,
  readPendingPayload,
  removePendingPayload,
  replayPendingPayloads,
  queueDir,
  queueMaxSize,
} from "../src/queue.mjs";

let workDir;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "runner-queue-"));
  process.env.RUNNER_QUEUE_DIR = workDir;
  delete process.env.RUNNER_QUEUE_MAX_SIZE;
});

afterEach(async () => {
  delete process.env.RUNNER_QUEUE_DIR;
  delete process.env.RUNNER_QUEUE_MAX_SIZE;
  try { await rm(workDir, { recursive: true, force: true }); } catch (_) {}
});

describe("queueDir / queueMaxSize", () => {
  it("retourne le path par defaut si env vide", () => {
    delete process.env.RUNNER_QUEUE_DIR;
    expect(queueDir()).toBe("/tmp/runner-queue");
  });

  it("respecte RUNNER_QUEUE_DIR", () => {
    process.env.RUNNER_QUEUE_DIR = "/custom/queue";
    expect(queueDir()).toBe("/custom/queue");
  });

  it("retourne 100 par defaut", () => {
    expect(queueMaxSize()).toBe(100);
  });

  it("respecte RUNNER_QUEUE_MAX_SIZE", () => {
    process.env.RUNNER_QUEUE_MAX_SIZE = "5";
    expect(queueMaxSize()).toBe(5);
  });
});

describe("enqueuePayload", () => {
  it("ecrit un fichier JSON dans le dossier de queue", async () => {
    const filename = await enqueuePayload(
      { slug: "acme", status: "pass", passed: 2, failed: 0, total: 2 },
      1700000000000
    );
    expect(filename).toMatch(/^1700000000000-acme-nojob\.json$/);
    const entry = await readPendingPayload(filename);
    expect(entry.queuedAt).toBe(1700000000000);
    expect(entry.payload.slug).toBe("acme");
    expect(entry.payload.passed).toBe(2);
  });

  it("integre jobId dans le nom de fichier si present", async () => {
    const filename = await enqueuePayload({ slug: "acme", job_id: 42 }, 1700000000000);
    expect(filename).toMatch(/-42\.json$/);
  });

  it("sanitize les caracteres bizarres dans slug/jobId", async () => {
    const filename = await enqueuePayload(
      { slug: "ac/me\\bad", job_id: "evil; rm -rf /" },
      1700000000000
    );
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("\\");
    expect(filename).not.toContain(";");
    expect(filename).not.toContain(" ");
  });

  it("retourne null et logge error si la queue est pleine", async () => {
    process.env.RUNNER_QUEUE_MAX_SIZE = "2";
    await enqueuePayload({ slug: "a" }, 1);
    await enqueuePayload({ slug: "b" }, 2);
    const result = await enqueuePayload({ slug: "c" }, 3);
    expect(result).toBeNull();
    const files = await readdir(workDir);
    expect(files).toHaveLength(2);
  });
});

describe("listPendingPayloads", () => {
  it("retourne les fichiers tries par nom (FIFO timestamp-based)", async () => {
    await enqueuePayload({ slug: "third" }, 3000);
    await enqueuePayload({ slug: "first" }, 1000);
    await enqueuePayload({ slug: "second" }, 2000);
    const pending = await listPendingPayloads();
    expect(pending).toHaveLength(3);
    expect(pending[0]).toContain("1000-first");
    expect(pending[1]).toContain("2000-second");
    expect(pending[2]).toContain("3000-third");
  });

  it("retourne tableau vide si le dossier n'existe pas", async () => {
    process.env.RUNNER_QUEUE_DIR = "/tmp/n-existe-pas-runner-queue-test";
    const pending = await listPendingPayloads();
    expect(pending).toEqual([]);
  });

  it("ignore les fichiers non-json", async () => {
    await writeFile(join(workDir, "garbage.txt"), "not a payload");
    await enqueuePayload({ slug: "ok" }, 1000);
    const pending = await listPendingPayloads();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain(".json");
  });
});

describe("removePendingPayload", () => {
  it("supprime le fichier", async () => {
    const filename = await enqueuePayload({ slug: "acme" }, 1000);
    await removePendingPayload(filename);
    const remaining = await listPendingPayloads();
    expect(remaining).toHaveLength(0);
  });

  it("ne throw pas si le fichier n'existe pas", async () => {
    await expect(removePendingPayload("inexistant.json")).resolves.toBeUndefined();
  });
});

describe("replayPendingPayloads", () => {
  it("ne fait rien si la queue est vide", async () => {
    const pushFn = vi.fn();
    const result = await replayPendingPayloads(pushFn);
    expect(result).toEqual({ replayed: 0, remaining: 0 });
    expect(pushFn).not.toHaveBeenCalled();
  });

  it("rejoue tous les payloads dans l'ordre FIFO et supprime les fichiers", async () => {
    await enqueuePayload({ slug: "first" }, 1000);
    await enqueuePayload({ slug: "second" }, 2000);
    await enqueuePayload({ slug: "third" }, 3000);

    const pushed = [];
    const pushFn = vi.fn().mockImplementation(async (payload) => {
      pushed.push(payload.slug);
      return { ok: true };
    });

    const result = await replayPendingPayloads(pushFn);
    expect(result).toEqual({ replayed: 3, remaining: 0 });
    expect(pushed).toEqual(["first", "second", "third"]);
    const remaining = await listPendingPayloads();
    expect(remaining).toHaveLength(0);
  });

  it("stoppe au premier echec et conserve les payloads restants", async () => {
    await enqueuePayload({ slug: "first" }, 1000);
    await enqueuePayload({ slug: "second" }, 2000);
    await enqueuePayload({ slug: "third" }, 3000);

    let callCount = 0;
    const pushFn = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true };
      return { ok: false, status: 503 };
    });

    const result = await replayPendingPayloads(pushFn);
    expect(result).toEqual({ replayed: 1, remaining: 2 });
    expect(pushFn).toHaveBeenCalledTimes(2); // pas de 3eme tentative apres echec
    const remaining = await listPendingPayloads();
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toContain("2000-second");
    expect(remaining[1]).toContain("3000-third");
  });

  it("supprime et logge un fichier illisible (corruption)", async () => {
    await writeFile(join(workDir, "1000-corrupt-x.json"), "{ pas du JSON valide");
    const pushFn = vi.fn().mockResolvedValue({ ok: true });
    const result = await replayPendingPayloads(pushFn);
    expect(result.replayed).toBe(0);
    expect(pushFn).not.toHaveBeenCalled();
    const remaining = await listPendingPayloads();
    expect(remaining).toHaveLength(0);
  });
});
