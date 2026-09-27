// Agent-facing rendering of a compile result: verdict header, then errors, sorries, warnings; errors absorb any cut.
import { checkStatus, headerFacts } from "./verdict.js";

export const RENDER_CAP = 16000;

const HEARTBEAT_TIMEOUT = /maximum number of heartbeats/;
export const heartbeatNote = (maxHeartbeats) =>
  `NOTE (harness): every check fixes maxHeartbeats at ${maxHeartbeats} per declaration — typeclass ` +
  `synthesis included — and a \`set_option ...maxHeartbeats\` in your file can only lower that, never ` +
  `raise it. Raising it will not help: make the step cheaper instead (smaller ` +
  `\`decide\`/\`interval_cases\` ranges, fewer \`simp\` lemmas, split the work into separate lemmas so ` +
  `each gets its own allowance), and for a failing instance search, supply the instance explicitly.`;

// Collapses identical message texts to the first site plus a locator list.
const SITE_LIST_MAX = 24;
function dedupe(msgs, label) {
  const groups = new Map();
  for (const m of msgs) {
    const g = groups.get(m.text);
    if (g) g.sites.push(`${m.line}:${m.column}`);
    else groups.set(m.text, { m, sites: [] });
  }
  return [...groups.values()].map(({ m, sites }) => {
    const head = `${m.severity}: ${label}:${m.line}:${m.column}: ${m.text}`;
    if (!sites.length) return head;
    const shown = sites.slice(0, SITE_LIST_MAX).join(", ");
    const rest = sites.length > SITE_LIST_MAX ? `, +${sites.length - SITE_LIST_MAX} more` : "";
    return `${head}\n(same message also at ${shown}${rest})`;
  });
}

export function renderCheck({
  messages = [],
  sorries = [],
  label = "problem.lean",
  cap = RENDER_CAP,
  outputName = null,
  maxHeartbeats = null,
  ok = undefined,
  stmt = undefined,
  axiomsBad = undefined,
  axSorries = undefined,
}) {
  const msgs = messages ?? [];
  const srs = sorries ?? [];
  const errs = msgs.filter((m) => m.severity === "error");
  const warns = msgs.filter((m) => m.severity !== "error");
  const status = checkStatus({ ok, messages: msgs, sorries: srs, stmt, axiomsBad, axSorries });

  const errParts = dedupe(errs, label);
  const sorryParts = srs.map((s) => `sorry at line ${s.line}, goal:\n  ${s.goal}`);
  const warnParts = dedupe(warns, label);
  if (maxHeartbeats != null && msgs.some((m) => HEARTBEAT_TIMEOUT.test(m.text ?? "")))
    warnParts.push(heartbeatNote(maxHeartbeats));

  const head = `${status.label} — ${headerFacts(status, errParts.length).join(", ")}`;
  const headPretty = outputName ? `${head} · full output: ${outputName}` : head;
  const errText = errParts.join("\n\n");
  const tailText = [...sorryParts, ...warnParts].join("\n\n");
  const join = (...xs) => xs.filter(Boolean).join("\n\n");

  const marker = `[... errors truncated${outputName ? ` — full compiler output in ${outputName}` : ""}]`;
  let pretty = join(headPretty, errText, tailText);
  if (pretty.length > cap) {
    const room = cap - headPretty.length - tailText.length - marker.length - 6;
    pretty =
      room > 500
        ? join(headPretty, `${errText.slice(0, room)}\n${marker}`, tailText)
        : join(headPretty, errText, tailText).slice(0, cap - marker.length - 1) + `\n${marker}`;
  }
  return { ok: status.compiles, status, pretty, full: join(head, errText, tailText) };
}
