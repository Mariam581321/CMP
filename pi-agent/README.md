# pi-agent/ — the agent dir CMP runs use

`runner/run.js` points pi's `PI_CODING_AGENT_DIR` here, so the retry policy is
versioned with the experiment instead of living in `~/.pi/agent/`.

## Why `retry.provider.maxRetries: 500`

pi retries at two levels. The **provider** level sits inside the openai SDK,
below the message layer: nothing is emitted, so the model's context never learns
the request failed. Its backoff is clamped at 8s (0.5, 1, 2, 4, then 8s forever),
so 500 retries ≈ an hour of re-probing the link every ~7s. It was **0** by
default on the DeepSeek path, so every wifi blip fell through to the **agent**
level, which retries the whole turn 3 times over 14 seconds, gives up, and lets
the supervisor inject a recovery nudge the model does see.

Agent level stays at 3: its backoff is exponential with no clamp, so long
coverage there means 30-minute dead sleeps. It only needs to cover mid-stream
drops, which the SDK cannot retry (0.4% of observed failures).

Verified 2026-07-30 against a stub that killed every socket for 45s: pi retried
11 times at 0.5–8s spacing, then succeeded, and the session recorded zero errors.

## Reading link health afterwards

Absorbed retries are logged to each attempt's `stderr.log` (`OPENAI_LOG=info`,
set by run.js):

    grep -c "retrying," results/<run>/*/stderr.log      # failures the SDK absorbed
    grep -c "succeeded with status" results/<run>/*/stderr.log   # total requests

`events.jsonl` still shows `stopReason: "error"` for anything the SDK could not
fix, which should now be rare. Baselines measured from the 0726–0730 events:
~2–5% of requests failed on a stable night, 7–8% on a bad one, 23% with the
uplink dead.

No secrets here — the repo is public; credentials stay in `.env`.

Note this dir replaces `~/.pi/agent/` for runs, so a custom model defined in
`~/.pi/agent/models.json` (e.g. the Bedrock Nova entry) is not visible to a run.
DeepSeek comes from pi's built-in catalog, so nothing needed copying; a Bedrock
detour would need its `models.json` entry here, and run.js's catalog preflight
will fail loudly rather than mis-price it.
