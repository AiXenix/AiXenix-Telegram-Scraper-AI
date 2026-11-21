// Model requests to any OpenAI-compatible chat completions API. The request
// carries only the model and one user message, which every such API accepts;
// the reasoning setting is not sent because support for it differs by provider.
import { errorMessage, type LlmRequest, type LlmRunner } from "../platform.ts";

export function createOpenAiLlm(options: { apiBaseUrl: string; apiKey: string; fetch: typeof fetch }): LlmRunner {
  const url = `${options.apiBaseUrl.replace(/\/+$/u, "")}/chat/completions`;
  return {
    async run(request: LlmRequest): Promise<string> {
      if (options.apiBaseUrl.trim() === "" || options.apiKey.trim() === "") {
        throw new Error("Для llm.backend = openai нужны llm.apiBaseUrl и llm.apiKey");
      }
      const timeout = AbortSignal.timeout(request.timeoutMs ?? 5 * 60_000);
      let response: Response;
      try {
        response = await options.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: request.model, messages: [{ role: "user", content: request.prompt }] }),
          signal: AbortSignal.any([request.signal, timeout]),
        });
      } catch (cause) {
        if (request.signal.aborted) throw cause;
        throw new Error(`API модели недоступен: ${errorMessage(cause)}`);
      }
      const raw = await response.text();
      if (!response.ok) throw new Error(`API модели ответил кодом ${response.status}: ${raw.slice(0, 300)}`);
      let content: unknown;
      try {
        const body = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] };
        content = body.choices?.[0]?.message?.content;
      } catch {
        throw new Error("API модели вернул не JSON");
      }
      if (typeof content !== "string" || content.trim() === "") throw new Error("API модели вернул пустой ответ");
      return content;
    },
  };
}
