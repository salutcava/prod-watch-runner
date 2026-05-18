/**
 * Logger structure JSON pour le runner. Sortie sur stdout, format JSON par
 * defaut pour faciliter le parsing cote client (genre Filebeat, Loki, etc.).
 * Si stdout n'est pas un TTY (= dans Docker), JSON. Si TTY (dev local), format
 * plus lisible.
 */
const TTY = process.stdout.isTTY;

function fmt(level, msg, extra = {}) {
  const ts = new Date().toISOString();
  if (TTY) {
    const color = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" }[level] || "";
    const reset = "\x1b[0m";
    const extras = Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
    return `${color}[${ts}] [${level.toUpperCase()}]${reset} ${msg}${extras}`;
  }
  return JSON.stringify({ ts, level, msg, ...extra });
}

export const logger = {
  info: (msg, extra) => console.log(fmt("info", msg, extra)),
  warn: (msg, extra) => console.warn(fmt("warn", msg, extra)),
  error: (msg, extra) => console.error(fmt("error", msg, extra)),
};
