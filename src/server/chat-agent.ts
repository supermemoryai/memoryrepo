import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { stepCountIs, streamText, type ToolSet, type UIMessage } from "ai";
import type { Env } from "./env.ts";
import { chatInstructions, chatTools, ENTRY, type RepoWriter } from "./memory.ts";
import type { MemoryAgent } from "./memory-agent.ts";
import { metered, modelInfo, resolveModel } from "./models.ts";
import { metaOf, titleOf, toModelMessages, transcriptOf, type TranscriptMessage } from "./transcripts.ts";

const MAX_STEPS = 12;

/** Live stats for the last (or running) turn. */
export type TurnStats = {
  model: string;
  /** ms from the message arriving to the first model output, and to the end of the turn. */
  ttft: number | null;
  total: number | null;
  steps: number;
  toolCalls: number;
  /** Summed tool time (parallel calls overlap, so it can exceed wall time). */
  toolMs: number;
};
export type AskResult = {
  status: string;
  error?: string;
  messageId: string;
  reply: string;
  /** memory_write / memory_edit / memory_delete calls this turn made, with their commit results. */
  memoryWrites: { tool: string; input: Record<string, unknown>; output: string }[];
  tools: { tool: string; input: Record<string, unknown>; output: string }[];
  cost: { turn: number; thread: number };
  stats: TurnStats | null;
};

export type ChatState = {
  /** Live USD for the running (or last) turn and for the whole thread. */
  cost: { turn: number; thread: number };
  stats: TurnStats | null;
  error: string | null;
};

/** One per thread, named "<memory>.<thread>" (memory: "<user>" or "<user>.<bank>"). Answers, and remembers as it goes. */
export class ChatAgent extends AIChatAgent<Env, ChatState> {
  initialState: ChatState = { cost: { turn: 0, thread: 0 }, stats: null, error: null };

  async onChatMessage() {
    const t0 = Date.now();
    const dot = this.name.lastIndexOf(".");
    const [memoryAgent, thread] = [this.name.slice(0, dot), this.name.slice(dot + 1)];
    const memory = await getAgentByName(this.env.MemoryAgent, memoryAgent);
    await memory.touchThread(thread, titleOf(this.messages), this.messages.length);

    const budget = await memory.budget();
    if (budget.left <= 0) {
      const resets = new Date(budget.resets).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      const error = `You've reached this month's usage limit. It resets on ${resets}.`;
      this.setState({ ...this.state, error });
      throw new Error(error);
    }

    let ctx: Awaited<ReturnType<typeof memory.chatContext>>;
    try {
      ctx = await memory.chatContext();
    } catch (error) {
      this.setState({ ...this.state, error: `memory unavailable: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
    const threadBefore = await memory.threadCost(thread);
    const stats: TurnStats = { model: modelInfo(ctx.chatModel).name, ttft: null, total: null, steps: 0, toolCalls: 0, toolMs: 0 };
    let turnCost = 0;
    this.setState({ cost: { turn: 0, thread: threadBefore }, stats: { ...stats }, error: null });

    const model = metered(resolveModel(ctx.chatModel, this.env.OPENROUTER_API_KEY), ctx.chatModel, (u) => {
      turnCost += u.cost;
      void memory.recordUsage("chat", thread, u);
      this.setState({ ...this.state, cost: { turn: turnCost, thread: threadBefore + turnCost } });
    });

    const session = { thread, message: [...this.messages].reverse().find((m) => m.role === "user")?.id ?? "" };
    const today = new Date().toISOString().slice(0, 10);
    const tools = this.timed(chatTools(ctx.files, this.repoWriter(memory, ctx.head), session), stats);
    let first = true;

    const result = streamText({
      model,
      instructions: chatInstructions(ctx.files[ENTRY] ?? "", today, session),
      messages: await toModelMessages(this.messages),
      tools,
      // Also stop at the monthly cap: a turn can overshoot it by at most one step.
      stopWhen: [stepCountIs(MAX_STEPS), () => turnCost >= budget.left],
      onChunk: ({ chunk }) => {
        if (!first || !["text-delta", "reasoning-delta", "tool-input-start", "tool-call"].includes(chunk.type)) return;
        first = false;
        stats.ttft = Date.now() - t0;
        this.setState({ ...this.state, stats: { ...stats } });
      },
      onStepFinish: () => {
        stats.steps++;
        this.setState({ ...this.state, stats: { ...stats } });
      },
      onError: ({ error }) => {
        // e.g. a bad API key or an unavailable model: show it instead of an empty reply.
        this.setState({ ...this.state, error: error instanceof Error ? error.message : String(error) });
      },
      onFinish: () => {
        stats.total = Date.now() - t0;
        this.setState({ ...this.state, stats: { ...stats } });
        void memory.touchThread(thread, titleOf(this.messages), this.messages.length + 1);
      },
    });

    // Stamp messages with time and timezone so dreaming knows when things were said.
    const tz = metaOf(this.messages[this.messages.length - 1]!).tz;
    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => (part.type === "start" ? { createdAt: Date.now(), tz, model: ctx.chatModel } : undefined),
    });
  }

  /**
   * Run one turn without a WebSocket (the HTTP API). Persists the user message, runs the same turn
   * the UI gets (memory lookups and writes included), and returns the reply plus what it did.
   */
  async ask(text: string, tz?: string): Promise<AskResult> {
    const id = `api-${crypto.randomUUID().slice(0, 12)}`;
    const user: UIMessage = { id, role: "user", parts: [{ type: "text", text }], metadata: { createdAt: Date.now(), tz: tz ?? "UTC" } };
    const outcome = await this.saveMessages((messages) => [...messages, user]);
    const at = this.messages.findIndex((m) => m.id === id);
    const reply = at >= 0 ? this.messages.slice(at + 1).find((m) => m.role === "assistant") : undefined;
    const tools = (reply?.parts ?? [])
      .filter((p) => p.type.startsWith("tool-"))
      .map((p) => {
        const part = p as { type: string; input?: Record<string, unknown>; output?: unknown };
        return { tool: part.type.slice(5), input: part.input ?? {}, output: typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? null) };
      });
    return {
      status: outcome.status,
      error: outcome.error ?? this.state.error ?? undefined,
      messageId: id,
      reply: reply ? reply.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n").trim() : "",
      memoryWrites: tools.filter((t) => t.tool.startsWith("memory_")),
      tools,
      cost: this.state.cost,
      stats: this.state.stats,
    };
  }

  /** Plain-text transcript, for dreaming, source checks and search. */
  transcript(): TranscriptMessage[] {
    return transcriptOf(this.messages as UIMessage[]);
  }

  /** Chat-time writes go through the user's MemoryAgent, which owns the repo and serializes pushes. */
  private repoWriter(memory: DurableObjectStub<MemoryAgent>, head: string | null): RepoWriter {
    let current = head;
    return {
      commit: async (changes, message) => {
        const outcome = await memory.applyEdits(current, changes, message);
        if (outcome.ok || outcome.reason === "conflict") current = outcome.head;
        return outcome;
      },
    };
  }

  /** Count and time every tool call for the live stats. */
  private timed(tools: ToolSet, stats: TurnStats): ToolSet {
    const out: ToolSet = {};
    for (const [name, t] of Object.entries(tools)) {
      const execute = t.execute;
      out[name] = !execute
        ? t
        : {
            ...t,
            execute: async (input: unknown, options: Parameters<NonNullable<typeof execute>>[1]) => {
              const start = Date.now();
              try {
                return await execute(input as never, options);
              } finally {
                stats.toolCalls++;
                stats.toolMs += Date.now() - start;
                this.setState({ ...this.state, stats: { ...stats } });
              }
            },
          };
    }
    return out;
  }
}
