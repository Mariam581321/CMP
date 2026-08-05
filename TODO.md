# TODO

## DONE 2026-08-02 — CMP is off the laptop

Running on `cmp`: a Hetzner auction box, 6C/12T, 62 GB usable, no Windows and no WSL
underneath. Consequences already banked: the REPL pool defaults to 8 workers
(`CMP_REPL_WORKERS` in `runner/lean-server.js`), run concurrency defaults to 25
(`runner/run.js` — the laptop-era 12 GB memory floor is gone), and the memory fuses have
not fired since the move. The watchdog lives in a tmux session (`tmux attach -t
watchdog`) rather than a foreground terminal, so it survives session teardown, which was
the last laptop-shaped failure mode in the harness. The `claude remote-control` story
below is still accurate and still the way to drive a run from elsewhere.

Original entry follows.

## Get CMP off the laptop: a small VPS (and where Claude Code fits)

**Why:** the laptop is the least reliable part of the harness — sleep corrupts runs
(0728), the WSL ceiling is 12 GB on a 16 GB machine, and a 100-problem run takes
~12-48 h that the laptop must stay awake for. A VPS removes the entire failure class
and lets runs continue while traveling.

**What to rent (checked 2026-08-01, after the AI-boom RAM repricing):**
- Cloud is no longer the cheap option: Hetzner raised cloud prices 30-50% in Apr 2026
  and again in June (RAM procurement costs); a 16 GB shared box (CPX42) is now
  ~€70/mo in Germany, more elsewhere.
- **The Hetzner server auction (hetzner.com/sb) is the deal**: cancelled older
  dedicated machines, only ~3% price increase because the hardware predates the RAM
  squeeze. ~€30-45/mo gets 64 GB RAM + a real 6-12 core CPU (Ryzen 3600/3700X or
  Xeon E-2176G class — Lean prefers fast single cores), no setup fee, monthly
  cancellable. 64 GB = 2 REPL workers + high concurrency, memory fuses never fire.
  Track deals via radar.iodev.org. Caveats: bare metal (no snapshots/hourly billing),
  must actively cancel, provisioning minutes-to-hours.
- Either way beats the laptop's 12 GB WSL slice: no Windows underneath, no sleep,
  no pageReporting battles.
- Setup is a one-session job Claude can drive end-to-end over ssh from the laptop:
  install elan + Lean toolchain, `lake exe cache get` (Mathlib arrives prebuilt, no
  compile), node, pi, clone CMP, tmux, done. Ubuntu default; nothing exotic.

**How this interacts with Claude Code remote (verified against docs 2026-08-01):**
- **`claude remote-control` (exists, is the answer):** run Claude Code CLI on the VPS
  inside tmux, start it with remote-control, and drive that session from a browser or
  the Claude mobile app from anywhere. The session lives as long as the tmux process
  on the always-on VPS. This is the officially documented "remote machine" pattern —
  docs: https://code.claude.com/docs/en/remote-control.md
- **claude.ai/code cloud sessions (exist, unsuitable):** Anthropic-managed sandboxes,
  ~4 vCPU / 16 GB / 30 GB, cannot host a persistent 6-12 GB Lean server for days and
  cannot connect out to a private VPS. Fine for code work, wrong shape for CMP runs.
- **Routines / scheduled cloud agents (exist, unsuitable):** same sandboxes, meant for
  stateless recurring tasks (PR review etc.), not persistent infrastructure.
- **What does not exist:** a fire-and-forget "deploy an agent to a VPS" mode. The
  supported shape is exactly the one CMP already has: run.js does the unattended work,
  the watchdog babysits the server, and a Claude session (local or remote-control)
  is opened to launch/analyze — now just on a machine that never sleeps.
- DeepSeek doesn't care where the box is; it's outbound HTTPS like today.

**UX for a mathematician:** after the one-time setup, the workflow is: open
claude.ai (or the app) → the VPS session is there → "launch the next run" / "how's
the run going" — same conversation as today, no ssh knowledge needed day-to-day.

## DONE 2026-08-02 — check verdicts are deterministic: `maxHeartbeats` replaced the CPU-second budget

Implemented (see SKELETON.md "The verdict is deterministic" for the mechanism of record):
verdict = per-declaration `maxHeartbeats 400000` (`MAX_HEARTBEATS` in runner/common.js —
the cap every check has injected since 2026-07-12, so no calibration replay was needed:
keeping it leaves the elaboration side of every past verdict in place, and dropping the
CPU conviction is one-directional, old fails can only become passes). Submitted files
cannot raise it (server-side clamp, all numeral forms; lowering allowed; over-cap errors
carry a harness note saying raising cannot help). CPU is now a pure machine fuse (600 s,
never a verdict, never memoized — exhausted retries end in `unavailable`/`grader_error`).
`--check-cpu`/`check_cpu_ms` are gone; run.json records `max_heartbeats` read from the
live server's /health and run.js refuses to launch on a cap mismatch. Verified on-box:
clamp evasions (raise/0/`_`/hex/`in`-form) all verdict at 400000; 3 forced recompiles
byte-identical; kernel-heavy `decide` (the heartbeat-blind class) ends as crash/
`unavailable`, flagged not verdicted. Descoped as unnecessary for determinism: the
calibration replay (see above) and the durable on-disk verdict memo (the grader's fresh
compile now reproduces the agent's verdict by construction).

Still open (methodology, not code): freeze re-cut on the commit that lands this;
lean-search-fateh100-0801 sits on the old side — bucket its budget-borderline attempts
and report both ways, or re-run.

Original entry follows.

## Check verdicts must be deterministic: replace the CPU-second budget with `maxHeartbeats`

**The incident (2026-08-01, fateh_32 in lean-search-fateh100-0801):** a ~49KB proof
sat right on the 120 CPU-second line. Same bytes, four measurements, four coin flips:
agent's check passed → supervisor's check said over-budget (spurious nudge) → agent's
re-checks passed → grader's check said over-budget → recorded `compile_error` on a
proof the agent watched compile. Any verdict defined by a *measured* quantity has a
noise band around its threshold; CPU-seconds narrowed the band vs wall clock (0731)
but cannot zero it. Raising 120 only moves the line.

**The fix — count, don't measure:**

1. **Verdict = Lean's deterministic timeout.** Enforce a per-declaration
   `maxHeartbeats` cap in the check path. Heartbeats count elaboration steps — a pure
   function of the file, identical on any machine, under any load, at any REPL age.
   Over-cap becomes an ordinary, byte-reproducible compile error in the file
   ("(deterministic) timeout"), the same for agent, supervisor, grader, and any
   future regrade.
2. **Calibrate once, then freeze the number.** Replay the logged check corpus (0730b +
   0801 events have every submitted file) and pick the cap that best matches the
   ~120 CPU-second pass/fail set. The replay also measures how wide the flip band
   actually was.
3. **CPU becomes a fuse, never a verdict.** Wall/RSS/mem kills already never convict;
   extend that to CPU. Set it far from the action (e.g. 600 CPU-s) as pure machine
   protection — requeue on trip, no charged verdicts.
4. **One measurement ever per unique file.** Durable check-verdict memo keyed by exact
   file bytes, on disk, shared by agent tool, supervisor, and grader. The grader never
   re-decides "compiles" — it reuses the recorded verdict for the final file and
   compiles only to extract statement probes/axioms under a generous backstop. This
   makes "a solve must be observable inside the agent's own feedback loop" (stmt.js)
   literal: the agent's observed verdict IS the verdict of record.

**To verify during implementation:**
- Heartbeats bound elaboration, not kernel reduction — test whether a `decide`-heavy
  file can pass the cap while burning CPU, and whether the kernel can be bounded
  deterministically too; if not, that rare class gets flagged, not verdicted.
- How to inject the option through the REPL per-check (per-command `set_option` vs
  REPL-level default), without letting a submitted file raise its own cap.

**Consequences:** this changes check semantics → freeze re-cut. lean-search-fateh100-0801
sits on the old side; for its analysis, bucket attempts as "budget-borderline" (recorded
budget-fail in grade detail but final agent-side check passed in events.jsonl) and report
both ways. Whether the run is re-run or the boundary is just recorded in the commit log is
a methodology decision, not code.
