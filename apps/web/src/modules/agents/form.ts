import {
  agentInputSchema,
  DEFAULT_ESCALATION_MESSAGE,
  DEFAULT_INSTRUCTIONS,
  type Agent,
  type AgentInput,
  type NoAnswerMode,
  type ReplyMode,
} from "@support-agent/shared/api/agents";

/** The agent form: text fields stay strings; the schema turns blanks into null. */
export type AgentFormValues = {
  name: string;
  enabled: boolean;
  instructions: string;
  providerId: string | null;
  model: string;
  fallbackProviderId: string | null;
  fallbackModel: string;
  replyMode: ReplyMode;
  followUpsInThreads: boolean;
  noAnswerMode: NoAnswerMode;
  escalationMessage: string;
  displayName: string;
  iconUrl: string;
  readImages: boolean;
  channels: string[];
  knowledgeSourceIds: string[];
};

/** Values of a saved agent, or of a new one (off, default instructions and escalation message). */
export function toFormValues(agent: Agent | null): AgentFormValues {
  if (!agent) {
    return {
      name: "",
      enabled: false,
      instructions: DEFAULT_INSTRUCTIONS,
      providerId: null,
      model: "",
      fallbackProviderId: null,
      fallbackModel: "",
      replyMode: "questions",
      followUpsInThreads: true,
      noAnswerMode: "escalate",
      escalationMessage: DEFAULT_ESCALATION_MESSAGE,
      displayName: "",
      iconUrl: "",
      readImages: false,
      channels: [],
      knowledgeSourceIds: [],
    };
  }
  return {
    name: agent.name,
    enabled: agent.enabled,
    instructions: agent.instructions,
    providerId: agent.providerId,
    model: agent.model,
    fallbackProviderId: agent.fallbackProviderId,
    fallbackModel: agent.fallbackModel ?? "",
    replyMode: agent.replyMode,
    followUpsInThreads: agent.followUpsInThreads,
    noAnswerMode: agent.noAnswerMode,
    escalationMessage: agent.escalationMessage,
    displayName: agent.displayName ?? "",
    iconUrl: agent.iconUrl ?? "",
    readImages: agent.readImages,
    channels: agent.channels.map((channel) => channel.id),
    knowledgeSourceIds: agent.knowledgeSourceIds,
  };
}

/** The unsaved form values as an agent for the test console, or the first problem. */
export function draftFromValues(
  values: AgentFormValues,
): { ok: true; draft: AgentInput } | { ok: false; message: string } {
  const result = agentInputSchema.safeParse(values);
  if (result.success) return { ok: true, draft: result.data };
  return { ok: false, message: result.error.issues[0]?.message ?? "" };
}
