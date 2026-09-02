const PATCH_MARKER = "pi-web-mid-run-auto-compaction-v2";
const PREVIOUS_PATCH_MARKER = "pi-web-mid-run-auto-compaction-v1";
const PREVIOUS_TOKEN_CHECK = `        const directContextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
        const contextTokens = directContextTokens > 0
            ? directContextTokens
            : estimateContextTokens(turn.context.messages).tokens;`;
const CURRENT_TOKEN_CHECK = `        const directContextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
        // Provider usage was measured before this turn's tool results were appended.
        // Keep its authoritative baseline, but never ignore a larger complete-context estimate.
        const estimatedContextTokens = estimateContextTokens(turn.context.messages).tokens;
        const contextTokens = Math.max(directContextTokens, estimatedContextTokens);`;

const ORIGINAL_METHOD = `    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
            const previousContext = previousSnapshot?.context ?? turn.context;
            return {
                ...previousSnapshot,
                context: {
                    ...previousContext,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }`;

const PATCHED_METHOD = `    // ${PATCH_MARKER}
    async _compactAtMidRunThreshold(turn) {
        if (turn.toolResults.length === 0) {
            return false;
        }
        const message = turn.message;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
            return false;
        }
        const settings = this.settingsManager.getCompactionSettings();
        const model = this.model;
        if (!settings.enabled ||
            !model ||
            message.provider !== model.provider ||
            message.model !== model.id) {
            return false;
        }
        const directContextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
        // Provider usage was measured before this turn's tool results were appended.
        // Keep its authoritative baseline, but never ignore a larger complete-context estimate.
        const estimatedContextTokens = estimateContextTokens(turn.context.messages).tokens;
        const contextTokens = Math.max(directContextTokens, estimatedContextTokens);
        if (!shouldCompact(contextTokens, model.contextWindow, settings)) {
            return false;
        }
        const before = getLatestCompactionEntry(this.sessionManager.getBranch());
        await this._runAutoCompaction("threshold", false);
        const after = getLatestCompactionEntry(this.sessionManager.getBranch());
        return after !== null && after.id !== before?.id;
    }
    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
            const compacted = await this._compactAtMidRunThreshold(turn);
            const previousContext = previousSnapshot?.context ?? turn.context;
            return {
                ...previousSnapshot,
                context: {
                    ...previousContext,
                    ...(compacted ? { messages: this.agent.state.messages.slice() } : {}),
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }`;

export function patchPiSdkMidRunCompaction(source) {
  if (source.includes(PATCH_MARKER)) return { source, status: "already-patched" };
  if (source.includes(PREVIOUS_PATCH_MARKER)) {
    const tokenCheckIndex = source.indexOf(PREVIOUS_TOKEN_CHECK);
    if (tokenCheckIndex < 0 || source.indexOf(PREVIOUS_TOKEN_CHECK, tokenCheckIndex + PREVIOUS_TOKEN_CHECK.length) >= 0) {
      throw new Error("Pi SDK previous mid-run compaction patch does not match the reviewed v1 layout");
    }
    return {
      source: source
        .replace(PREVIOUS_PATCH_MARKER, PATCH_MARKER)
        .replace(PREVIOUS_TOKEN_CHECK, CURRENT_TOKEN_CHECK),
      status: "patched",
    };
  }

  const firstIndex = source.indexOf(ORIGINAL_METHOD);
  if (firstIndex < 0 || source.indexOf(ORIGINAL_METHOD, firstIndex + ORIGINAL_METHOD.length) >= 0) {
    throw new Error("Pi SDK mid-run compaction source does not match the reviewed 0.84.3 layout");
  }
  return { source: source.replace(ORIGINAL_METHOD, PATCHED_METHOD), status: "patched" };
}

export { PATCH_MARKER };
