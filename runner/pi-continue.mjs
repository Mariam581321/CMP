#!/usr/bin/env node
// Promptless resume: continue a dead attempt's session from its last healthy entry
// with NOTHING appended to the context — pi's own retry semantics (agent-session.js
// _prepareRetry: "Remove error message from agent state (keep in session for
// history)", then agent.continue()) applied across a process restart.
//
// pi's CLI has no entry point for this (print mode only enters the loop through
// session.prompt(message), which appends a user message — modes/print-mode.js), but
// the primitive is public: pi-agent-core's Agent.continue() runs the loop from the
// state as-is. So: run pi's real main() with the attempt's original args plus
// "-c <SENTINEL>", and patch AgentSession.prototype.prompt so the sentinel — instead
// of being appended — replays _runAgentPrompt's continuation body without the initial
// message. All wiring (extensions, tools, system prompt, session restore, settled
// events the runner's supervisor relies on) is the CLI's own code path; the sentinel
// never touches the session file or the LLM request.
//
// Invoked by run.js --resume in place of the pi binary; args are identical.
import { execSync } from "node:child_process";
import { dirname } from "node:path";

export const SENTINEL = "<<cmp-pi-continue-sentinel>>";

const cliPath = execSync("readlink -f \"$(command -v pi)\"", { encoding: "utf8" }).trim();
const PKG = dirname(dirname(cliPath)); // .../pi-coding-agent (cli.js lives in dist/)

const { AgentSession } = await import(`${PKG}/dist/core/agent-session.js`);
const origPrompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function (text, options) {
  if (text !== SENTINEL) return origPrompt.call(this, text, options);
  // _runAgentPrompt minus the initial prompt append (agent-session.js). The leaf of
  // the restored session must not be an error-stopped assistant message — that is
  // rewind-scar.mjs's contract (leaf is a toolResult or a real supervisor nudge).
  this._isAgentRunActive = true;
  try {
    await this.agent.continue();
    while (await this._handlePostAgentRun()) {
      await this.agent.continue();
    }
  } finally {
    this._systemPromptOverride = undefined;
    this._flushPendingBashMessages();
    await this._emitAgentSettled();
  }
};

// Mirror dist/cli.js exactly (minus the prototype patch above).
const { APP_NAME } = await import(`${PKG}/dist/config.js`);
const { configureHttpDispatcher } = await import(`${PKG}/dist/core/http-dispatcher.js`);
const { main } = await import(`${PKG}/dist/main.js`);
process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = () => {};
configureHttpDispatcher();
await main(process.argv.slice(2));
