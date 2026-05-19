#!/usr/bin/env node
/**
 * Script appele par HEALTHCHECK Docker. Exit 0 si la boucle a touche le fichier
 * de fraicheur dans les healthStaleMs() dernieres ms, sinon exit 1.
 */
import { readHealthAge, healthStaleMs, healthFile } from "./health.mjs";

try {
  const stale = healthStaleMs();
  const age = await readHealthAge();
  if (age > stale) {
    console.error(`unhealthy: ${healthFile()} obsolete (age ${age}ms > ${stale}ms)`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(`unhealthy: ${err.message || err}`);
  process.exit(1);
}
