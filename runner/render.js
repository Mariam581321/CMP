// The ONE agent-facing rendering of a compile result. Used by the lean server's own
// render() (runner/lean-server.js), by lean_check/plan_check (runner/stmt.js
// renderWithoutProbe) and by check_snippet (runner/snippet.js), so every check tool
// speaks one format and a fix lands everywhere at once.
//
// Why this file exists at all — measured over the 13,058 lean_checks of the first two
// block-A cells (grep + semantic, both complete; `scripts/render-replay.mjs` reproduces
// every number below from the recorded session files):
// the old renderer emitted warnings first and sorries LAST, then took a blunt 8000-char
// prefix slice, so the cap ate the one thing that answers "am I done" first. 1,495
// checks (11.4%) truncated; in 178 of them the file HAD sorries and not one goal
// survived. 47% of all checks carry errors and sorries at once, so the order was wrong
// in half of all output, not just in the truncated tail.
//
// Three rules replace it, in this order of importance:
//   1. a header line that states the whole verdict — computed by runner/verdict.js, the
//      one place that decides what a green file is, so the word at the front of a check
//      agrees with the watermark, the supervisor and the grader by construction;
//   2. errors, then sorries, then warnings (style lints are off at source now: see
//      PREPARE_HEAD in check-env.js — a `set_option linter.* false` per class, which is
//      why the warning section is small enough to sit last);
//   3. if the result still exceeds the cap, the ERROR section absorbs the cut and says
//      so. Sorries and warnings are never what gets dropped, because the errors are the
//      only unbounded section (p50 217 chars but max 7,996, and up to 160 of them in one
//      check, against p90 835 for a goal and at most 14 sorries in any check on record).
// Nothing is ever lost either way: the caller writes `full` — the uncapped text — beside
// the attempt, and the header points at it.
import { checkStatus, headerFacts } from "./verdict.js";

export const RENDER_CAP = 16000;

// Lean's advice when a declaration runs out of heartbeats is "use `set_option
// maxHeartbeats <num>`", the one move this harness makes impossible (prepare() clamps
// it), so the note travels with the message. It used to be appended to EVERY heartbeat
// message — 3,991 copies across the two cells, 1.72 MB of the 39.2 MB those runs spent
// on check output. It says the same thing once now.
//
// ONE note, because there is now one number: `prepare()` sets both the elaboration
// budget and `synthInstance.maxHeartbeats` (typeclass search, Lean's default 20 000) to
// the cap, and `clampHeartbeats` lets a file lower either and raise neither. So the same
// sentence is true of every timeout Lean can print, and a second note explaining a
// distinction the agent can no longer act on would be noise on top of an error.
const HEARTBEAT_TIMEOUT = /maximum number of heartbeats/;
export const heartbeatNote = (maxHeartbeats) =>
  `NOTE (harness): every check fixes maxHeartbeats at ${maxHeartbeats} per declaration — typeclass ` +
  `synthesis included — and a \`set_option ...maxHeartbeats\` in your file can only lower that, never ` +
  `raise it. Raising it will not help: make the step cheaper instead (smaller ` +
  `\`decide\`/\`interval_cases\` ranges, fewer \`simp\` lemmas, split the work into separate lemmas so ` +
  `each gets its own allowance), and for a failing instance search, supply the instance explicitly.`;

// Identical message text at many positions is one fact, not N (2.1 MB of the 39.2 was
// exact duplicates). Collapse to the first site plus a locator list, which keeps every
// line number the agent needs to act — that is the part it cannot reconstruct.
// 24, not 8: a site is ~6 characters, so the whole list costs less than one line of a
// goal, and "+17 more" is a line number the agent has to go and find by hand.
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

/**
 * `ok`, `stmt`, `axiomsBad` and `axSorries` are the rest of the verdict, passed in by the caller that
 * has them (runner/stmt.js checkedCompile). They are what makes the header word mean
 * "this file would grade solved" rather than "the compiler printed no errors" — see
 * runner/verdict.js for why that distinction cost 683 self-contradicting checks.
 * check_snippet and the server's own `pretty` omit them, and then the header simply does
 * not claim anything about a statement a snippet does not have.
 */
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
  // The pointer rides on the header, so it is present on every check whether or not
  // anything was cut: a channel an agent meets only in the rare squeezed check is one it
  // never learns to use. `full` carries no pointer — it IS the thing pointed at.
  const headPretty = outputName ? `${head} · full output: ${outputName}` : head;
  const errText = errParts.join("\n\n");
  // Everything after the errors, kept whole whenever it fits at all.
  const tailText = [...sorryParts, ...warnParts].join("\n\n");
  const join = (...xs) => xs.filter(Boolean).join("\n\n");

  const marker = `[... errors truncated${outputName ? ` — full compiler output in ${outputName}` : ""}]`;
  let pretty = join(headPretty, errText, tailText);
  if (pretty.length > cap) {
    const room = cap - headPretty.length - tailText.length - marker.length - 6;
    pretty =
      room > 500
        ? join(headPretty, `${errText.slice(0, room)}\n${marker}`, tailText)
        : // Pathological: header + sorries alone overflow (many goals in huge contexts).
          // The header still carries every sorry line and the file still has everything.
          join(headPretty, errText, tailText).slice(0, cap - marker.length - 1) + `\n${marker}`;
  }
  return { ok: status.compiles, status, pretty, full: join(head, errText, tailText) };
}
