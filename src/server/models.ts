import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModel } from "ai";

/**
 * Open-weight models with tool calling, served through OpenRouter.
 * Prices are USD per 1M tokens as listed on OpenRouter (Oct 2026) and are only a fallback:
 * OpenRouter reports the exact cost of every call, which is what the UI shows.
 */
export type ModelInfo = { id: string; name: string; context: number; inPerM: number; outPerM: number };

export const MODELS: ModelInfo[] = [
  { id: "z-ai/glm-5.3", name: "GLM 5.3", context: 1_048_576, inPerM: 1.4, outPerM: 4.4 },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", context: 1_048_576, inPerM: 0.15, outPerM: 0.5 },
  { id: "deepseek/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", context: 1_048_576, inPerM: 0.55, outPerM: 5 },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context: 1_048_576, inPerM: 0.003, outPerM: 2.4 },
  { id: "moonshotai/kimi-k3", name: "Kimi K3", context: 1_048_576, inPerM: 0.67, outPerM: 14 },
  { id: "qwen/qwen3.8-2.4t-a95b", name: "Qwen3.8 2.4T A95B", context: 1_048_576, inPerM: 2, outPerM: 6 },
  { id: "qwen/qwen3.8-27b", name: "Qwen3.8 27B", context: 1_000_000, inPerM: 0.425, outPerM: 2.55 },
  { id: "minimax/minimax-m3", name: "MiniMax M3", context: 1_048_576, inPerM: 0.3, outPerM: 1.2 },
  { id: "xiaomi/mimo-v2.6-pro", name: "MiMo V2.6 Pro", context: 1_050_000, inPerM: 0.435, outPerM: 0.87 },
  { id: "openai/gpt-oss-120b", name: "gpt-oss-120b", context: 131_072, inPerM: 0.037, outPerM: 0.17 },
  { id: "mistralai/mistral-small-2603", name: "Mistral Small 4", context: 262_144, inPerM: 0.15, outPerM: 0.6 },
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", context: 1_048_576, inPerM: 0.188, outPerM: 0.653 },
];

export const DEFAULT_CHAT_MODEL = "z-ai/glm-5.3";
export const DEFAULT_DREAM_MODEL = "deepseek/deepseek-v4-pro-0813";

export const modelInfo = (id: string): ModelInfo => MODELS.find((m) => m.id === id) ?? { id, name: id, context: 200_000, inPerM: 0, outPerM: 0 };

export function resolveModel(id: string, apiKey: string): LanguageModel {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return createOpenRouter({ apiKey, compatibility: "strict", appName: "markdown-memory" }).chat(id, { parallelToolCalls: true });
}

/** One model call, as reported by the provider. `input` includes `cached`. */
export type CallUsage = { model: string; input: number; cached: number; output: number; cost: number; ms: number };

/** Wrap a model so every call (each agent step) reports tokens, cost and time. */
export function metered(model: LanguageModel, modelId: string, onCall: (u: CallUsage) => void): LanguageModel {
  if (typeof model === "string") return model;
  type Usage = { inputTokens: { total?: number; cacheRead?: number }; outputTokens: { total?: number } };
  type Meta = { openrouter?: { usage?: { cost?: number } } } | undefined;
  const report = (usage: Usage, meta: Meta, ms: number) => {
    const input = usage.inputTokens.total ?? 0;
    const cached = usage.inputTokens.cacheRead ?? 0;
    const output = usage.outputTokens.total ?? 0;
    const info = modelInfo(modelId);
    const listPrice = (input * info.inPerM + output * info.outPerM) / 1_000_000;
    onCall({ model: modelId, input, cached, output, cost: meta?.openrouter?.usage?.cost ?? listPrice, ms });
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const t0 = Date.now();
        const result = await doGenerate();
        report(result.usage, result.providerMetadata as Meta, Date.now() - t0);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const t0 = Date.now();
        const { stream, ...rest } = await doStream();
        const tap = new TransformStream({
          transform(part, controller) {
            if (part.type === "finish") report(part.usage, part.providerMetadata as Meta, Date.now() - t0);
            controller.enqueue(part);
          },
        });
        return { stream: stream.pipeThrough(tap), ...rest };
      },
    },
  });
}
