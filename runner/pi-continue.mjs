#!/usr/bin/env node
// Resume a pi session from its last entry without appending a prompt; takes the same args as pi.
import { execSync } from "node:child_process";
import { dirname } from "node:path";

export const SENTINEL = "<<cmp-pi-continue-sentinel>>";

const cliPath = execSync("readlink -f \"$(command -v pi)\"", { encoding: "utf8" }).trim();
const PKG = dirname(dirname(cliPath));

const { AgentSession } = await import(`${PKG}/dist/core/agent-session.js`);
const origPrompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function (text, options) {
  if (text !== SENTINEL) return origPrompt.call(this, text, options);
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

const { APP_NAME } = await import(`${PKG}/dist/config.js`);
const { configureHttpDispatcher } = await import(`${PKG}/dist/core/http-dispatcher.js`);
const { main } = await import(`${PKG}/dist/main.js`);
process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = () => {};
configureHttpDispatcher();
await main(process.argv.slice(2));
