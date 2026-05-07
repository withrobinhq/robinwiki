// Caller factories — agents are built per-call via createIngestAgents(config).
// Consumers build typed callers from the agents using createTypedCaller /
// createStringCaller and inject them as llmCall deps into stages.
export {
  createTypedCaller,
  createStringCaller,
  withTypedUsage,
  withStringUsage,
  AGENT_RETRY_CONFIG,
  AGENT_MODEL_SETTINGS,
} from './caller.js'
export type {
  UsageContext,
  UsageRecord,
  UsageRecorder,
  WithUsageOptions,
} from './caller.js'
