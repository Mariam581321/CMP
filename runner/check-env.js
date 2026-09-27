// What the lean server injects into every check, its resource bounds, and their fingerprint.
import { createHash } from "node:crypto";
import { MAX_HEARTBEATS } from "./common.js";

export const LINTERS = [
  "unusedSimpArgs", "unnecessarySimpa", "unusedVariables", "unnecessarySeqFocus",
  "unusedTactic", "unreachableTactic", "unusedSectionVars", "unusedRCasesPattern",
];
const LINTERS_OFF = LINTERS.map((l) => `set_option linter.${l} false`).join(" ");

const SYNTH_INSTANCE_BUDGET = `set_option synthInstance.maxHeartbeats ${MAX_HEARTBEATS}`;

export const PREPARE_HEAD = `set_option maxHeartbeats ${MAX_HEARTBEATS} ${SYNTH_INSTANCE_BUDGET} ${LINTERS_OFF}`;

const HEARTBEAT_OPTION = /(\bset_option\s+(?:\w+\.)*maxHeartbeats\s+)((?:0[xXbBoO])?[0-9a-fA-F_]+)/g;
export const clampHeartbeats = (line) =>
  line.replace(HEARTBEAT_OPTION, (whole, head, n) => {
    const v = Number(n.replace(/_/g, ""));
    return Number.isFinite(v) && v > 0 && v <= MAX_HEARTBEATS ? whole : `${head}${MAX_HEARTBEATS}`;
  });

// Clamp maxHeartbeats and replace the import block with PREPARE_HEAD.
export function prepare(code) {
  const lines = code.split("\n").map(clampHeartbeats);
  let capPlaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) {
      lines[i] = capPlaced ? "" : PREPARE_HEAD;
      capPlaced = true;
    }
  }
  let shifted = 0;
  if (!capPlaced) {
    lines.unshift(PREPARE_HEAD);
    shifted = 1;
  }
  return { text: lines.join("\n"), shifted };
}

// Resource bounds on a single check.
export const CPU_FUSE_MS = parseInt(process.env.CMP_CPU_FUSE_MS ?? "3600000");
export const WALL_FUSE_MS = parseInt(process.env.CMP_WALL_FUSE_MS ?? "5400000");
export const MAX_KILLS = 2;
const QUEUE_SLACK_MS = 30 * 60_000;
export const RETRY_DEADLINE_MS = MAX_KILLS * WALL_FUSE_MS + QUEUE_SLACK_MS;
export const CLIENT_WAIT_MS = RETRY_DEADLINE_MS + WALL_FUSE_MS + QUEUE_SLACK_MS;

// Everything the server enforces, for comparing server and checkout.
export function checkEnv() {
  return {
    max_heartbeats: MAX_HEARTBEATS,
    prepare_head: PREPARE_HEAD,
    cpu_fuse_ms: CPU_FUSE_MS,
    wall_fuse_ms: WALL_FUSE_MS,
    max_kills: MAX_KILLS,
    retry_deadline_ms: RETRY_DEADLINE_MS,
  };
}
export const CHECK_SHA = createHash("sha256").update(JSON.stringify(checkEnv())).digest("hex").slice(0, 16);

export function checkEnvDiff(theirs) {
  const mine = checkEnv();
  return Object.keys(mine)
    .filter((k) => JSON.stringify(mine[k]) !== JSON.stringify(theirs?.[k]))
    .map((k) => `    ${k}:\n      server:   ${theirs?.[k] ?? "(absent)"}\n      checkout: ${mine[k]}`);
}
