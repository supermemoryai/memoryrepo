import { wrapLanguageModel, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Open-weight models with tool calling, served through Workers AI (the env.AI binding —
 * no API key, no egress). Prices are USD per 1M tokens as listed by Cloudflare (Nov 2026);
 * the binding reports no per-call cost, so the meter below uses these list prices.
 */
export type ModelInfo = { id: string; name: string; context: number; inPerM: number; outPerM: number };

export const MODELS: ModelInfo[] = [
  { id: "@cf/zai-org/glm-5.3", name: "GLM 5.3", context: 1_048_576, inPerM: 1.4, outPerM: 4.4 },
  { id: "@cf/qwen/qwen3.8-27b", name: "Qwen3.8 27B", context: 262_144, inPerM: 0.45, outPerM: 3.2 },
  { id: "@cf/openai/gpt-oss-120b", name: "gpt-oss-120b", context: 128_000, inPerM: 0.35, outPerM: 0.75 },
  { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", context: 1_048_576, inPerM: 0.3, outPerM: 1.2 },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", context: 256_000, inPerM: 0.1, outPerM: 0.3 },
];

export const DEFAULT_CHAT_MODEL = "@cf/zai-org/glm-5.3";
export const DEFAULT_DREAM_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

/**
 * Workers AI retired these on 2026-11-20; calls now fail with HTTP 410 / error 5028.
 * Prefs and usage rows persisted before then still pin them, so map them forward
 * rather than handing a dead id to the binding. Kimi and Nemotron have no successor
 * in the catalog, so those selections fall back to the chat default.
 */
const RETIRED_MODELS: Record<string, string> = {
  "@cf/zai-org/glm-5.3-flash": "@cf/google/gemma-4-26b-a4b-it",
  "@cf/deepseek-ai/deepseek-v4-pro-0813": "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/deepseek-ai/deepseek-v4-flash-0731": "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/moonshotai/kimi-k2.6": DEFAULT_CHAT_MODEL,
  "@cf/nvidia/nemotron-3-120b-a12b": DEFAULT_CHAT_MODEL,
};

/** Resolve a possibly-retired model id to one the catalog still serves. */
export const migrateModelId = (id: string): string => RETIRED_MODELS[id] ?? id;

export const modelInfo = (id: string): ModelInfo => MODELS.find((m) => m.id === migrateModelId(id)) ?? { id, name: id, context: 200_000, inPerM: 0, outPerM: 0 };

export function resolveModel(id: string, ai: Ai): LanguageModel {
  return createWorkersAI({ binding: ai }).chat(migrateModelId(id));
}

/** One model call, as reported by the provider. `input` includes `cached`. */
export type CallUsage = { model: string; input: number; cached: number; output: number; cost: number; ms: number };

/** Wrap a model so every call (each agent step) reports tokens, cost and time. */
export function metered(model: LanguageModel, modelId: string, onCall: (u: CallUsage) => void): LanguageModel {
  if (typeof model === "string") return model;
  type Usage = { inputTokens: { total?: number; cacheRead?: number }; outputTokens: { total?: number } };
  const report = (usage: Usage, ms: number) => {
    const input = usage.inputTokens.total ?? 0;
    const cached = usage.inputTokens.cacheRead ?? 0;
    const output = usage.outputTokens.total ?? 0;
    const info = modelInfo(modelId);
    const listPrice = (input * info.inPerM + output * info.outPerM) / 1_000_000;
    onCall({ model: modelId, input, cached, output, cost: listPrice, ms });
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const t0 = Date.now();
        const result = await doGenerate();
        report(result.usage, Date.now() - t0);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const t0 = Date.now();
        const { stream, ...rest } = await doStream();
        const tap = new TransformStream({
          transform(part, controller) {
            if (part.type === "finish") report(part.usage, Date.now() - t0);
            controller.enqueue(part);
          },
        });
        return { stream: stream.pipeThrough(tap), ...rest };
      },
    },
  });
}
