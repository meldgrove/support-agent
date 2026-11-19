import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEARCH_API_CONFIG } from "@support-agent/shared/api/knowledge";
import {
  setLlmClientFactoryForTests,
  LlmError,
  type ChatResult,
  type JsonRequest,
  type LlmClient,
  type ProviderConnection,
} from "../llm";
import { runPipeline, type AgentRuntime } from "./pipeline";

type Reply = Record<string, unknown> | Error;

/** Fake models: replies by provider name and request schema ("triage" or "answer"). */
function fakeModels(replies: Record<string, { triage?: Reply; answer?: Reply }>) {
  const calls: { provider: string; request: JsonRequest }[] = [];
  setLlmClientFactoryForTests((connection: ProviderConnection): LlmClient => ({
    async chatJson(request): Promise<ChatResult> {
      calls.push({ provider: connection.name, request });
      const reply = replies[connection.name]?.[request.schemaName as "triage" | "answer"];
      if (!reply) throw new LlmError("unavailable", "no reply configured");
      if (reply instanceof Error) throw reply;
      return { text: JSON.stringify(reply), inputTokens: 100, outputTokens: 10, refused: false };
    },
    async listModels() {
      return [];
    },
  }));
  return calls;
}

const connection = (name: string): ProviderConnection => ({
  kind: "openai",
  name,
  baseUrl: null,
  apiKey: "k",
});

function agent(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "IT support",
    enabled: true,
    instructions: "Answer IT questions.",
    replyMode: "questions",
    followUpsInThreads: false,
    noAnswerMode: "escalate",
    escalationMessage: "Please ask <#C1|it-team> & wait.",
    displayName: null,
    iconUrl: null,
    readImages: true,
    channelIds: ["C123456"],
    main: { connection: connection("Main"), model: "main-model" },
    fallback: null,
    sources: [{ id: "s1", name: "IT KB", config: DEFAULT_SEARCH_API_CONFIG, secret: "t" }],
    ...overrides,
  };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Reset your password",
              url: "https://it.example.org/password",
              text: "Go to the portal and click Reset.",
            },
            { title: "Wi-Fi", url: "https://it.example.org/wifi", text: "The guest network is Guest." },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLlmClientFactoryForTests(null);
});

const input = (overrides: Partial<Parameters<typeof runPipeline>[0]> = {}) => ({
  agent: agent(),
  question: "How do I reset my password?",
  thread: [],
  images: [],
  mentioned: false,
  ...overrides,
});

describe("runPipeline", () => {
  it("stays silent when triage says so, without searching", async () => {
    fakeModels({ Main: { triage: { respond: false, reason: "A thank-you", searchQueries: [] } } });
    const result = await runPipeline(input({ question: "Thanks!" }));
    expect(result).toMatchObject({
      outcome: "silent",
      reason: "A thank-you",
      slackText: null,
      model: "main-model",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers from the sources and links only the cited ones", async () => {
    const calls = fakeModels({
      Main: {
        triage: { respond: true, reason: "Password question", searchQueries: ["reset password", " "] },
        answer: {
          status: "answered",
          answer: "Go to the **portal** and click Reset.",
          citedRefs: ["S1", "S9"],
        },
      },
    });
    const result = await runPipeline(input());
    expect(result.outcome).toBe("answered");
    expect(result.searchQueries).toEqual(["reset password"]);
    expect(result.sources.map((source) => source.ref)).toEqual(["S1", "S2"]);
    expect(result.citedRefs).toEqual(["S1"]);
    expect(result.slackText).toBe(
      "Go to the *portal* and click Reset.\n\n:page_facing_up: <https://it.example.org/password|Reset your password>",
    );
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    const answerPrompt = calls[1]!.request.messages[0]!.content[0];
    expect(answerPrompt).toMatchObject({ type: "text" });
    expect((answerPrompt as { text: string }).text).toContain(
      '<source ref="S1" title="Reset your password" url="https://it.example.org/password">',
    );
    expect(calls[1]!.request.system).toContain("Answer IT questions.");
  });

  it("links only URLs from the passages or the instructions", async () => {
    fakeModels({
      Main: {
        triage: { respond: true, reason: "Password question", searchQueries: ["reset password"] },
        answer: {
          status: "answered",
          answer:
            "Use [the portal](https://it.example.org/password/), [Wi-Fi](https://it.example.org/wifi) or [the helpdesk](https://help.example.org/new). Not [this](https://attacker.example/login).",
          citedRefs: ["S1"],
        },
      },
    });
    const result = await runPipeline(
      input({ agent: agent({ instructions: "Tickets: https://help.example.org/new." }) }),
    );
    expect(result.slackText).toBe(
      "Use <https://it.example.org/password|the portal>, <https://it.example.org/wifi|Wi-Fi> or <https://help.example.org/new|the helpdesk>. Not this.\n\n:page_facing_up: <https://it.example.org/password|Reset your password>",
    );
  });

  it("posts the escalation message when nothing answers the question", async () => {
    fakeModels({
      Main: {
        triage: { respond: true, reason: "Question", searchQueries: ["vpn"] },
        answer: { status: "no_answer", answer: "", citedRefs: [] },
      },
    });
    const result = await runPipeline(input({ question: "How does the VPN work?" }));
    expect(result.outcome).toBe("no_answer");
    expect(result.slackText).toBe("Please ask &lt;#C1|it-team&gt; &amp; wait.");
    const silent = await runPipeline(input({ agent: agent({ noAnswerMode: "silent" }) }));
    expect(silent.slackText).toBeNull();
  });

  it("uses the fallback model when the main model fails, for the rest of the message", async () => {
    const calls = fakeModels({
      Main: { triage: new LlmError("rate_limited", "The provider's rate limit was reached") },
      Backup: {
        triage: { respond: true, reason: "Question", searchQueries: ["password"] },
        answer: { status: "answered", answer: "Use the portal.", citedRefs: ["S1"] },
      },
    });
    const result = await runPipeline(
      input({ agent: agent({ fallback: { connection: connection("Backup"), model: "backup-model" } }) }),
    );
    expect(result).toMatchObject({
      outcome: "answered",
      usedFallback: true,
      provider: "Backup",
      model: "backup-model",
    });
    expect(calls.map((call) => `${call.provider}:${call.request.schemaName}`)).toEqual([
      "Main:triage",
      "Backup:triage",
      "Backup:answer",
    ]);
  });

  it("reports an error when every knowledge search fails", async () => {
    fakeModels({ Main: { triage: { respond: true, reason: "Question", searchQueries: ["x"] } } });
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const result = await runPipeline(input());
    expect(result).toMatchObject({
      outcome: "error",
      error: "IT KB: The search API answered 503",
      slackText: null,
    });
  });

  it("reports an error when no model works", async () => {
    fakeModels({ Main: { triage: new LlmError("authentication", "The API key was rejected") } });
    const result = await runPipeline(input());
    expect(result).toMatchObject({ outcome: "error", error: "The API key was rejected" });
  });

  it("passes images only when the agent reads them", async () => {
    const calls = fakeModels({ Main: { triage: { respond: false, reason: "No", searchQueries: [] } } });
    const image = { mediaType: "image/png" as const, data: "AAAA" };
    await runPipeline(input({ images: [image] }));
    expect(calls[0]!.request.messages[0]!.content).toContainEqual({ type: "image", image });
    await runPipeline(input({ images: [image], agent: agent({ readImages: false }) }));
    const second = calls[1]!.request.messages[0]!.content;
    expect(second.some((part) => part.type === "image")).toBe(false);
    expect((second[0] as { text: string }).text).toContain("The person attached an image.");
  });
});
