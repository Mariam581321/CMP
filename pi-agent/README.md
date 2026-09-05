# pi-agent/

The pi agent directory the runs use. `runner/run.js` sets `PI_CODING_AGENT_DIR` here so
that the retry policy is versioned with the experiment instead of living in
`~/.pi/agent/`.

`settings.json` raises pi's provider-level retries (inside the OpenAI SDK, invisible to
the model) to 500 with the backoff capped at 8 seconds, so a dropped connection is
re-probed for about an hour before anything reaches the agent loop. Agent-level retries
stay at 3. Absorbed retries are logged to each attempt's `stderr.log`
(`OPENAI_LOG=info`).

No credentials live here. The API key comes from `.env`; `auth.json` and `sessions/`
are ignored.
