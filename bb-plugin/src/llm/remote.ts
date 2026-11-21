// Model requests from the standalone script, served by the newsdesk plugin on
// a bb server: the plugin runs the request on the subscriptions connected to
// bb and returns the text. Start a job, then poll for its result.
import { errorMessage, sleep, type LlmRequest, type LlmRunner } from "../platform.ts";

export const REMOTE_LLM_PATH = "/api/v1/plugins/newsdesk/http";

export function createRemoteLlm(options: { bbUrl: string; token: string; fetch: typeof fetch }): LlmRunner {
  const base = `${options.bbUrl.replace(/\/+$/u, "")}${REMOTE_LLM_PATH}`;
  const headers = { "content-type": "application/json", "x-bb-plugin-token": options.token };
  const request = async (path: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const timeout = AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.any([signal, timeout]) });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new Error(`Сервер bb недоступен: ${errorMessage(cause)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Сервер bb отклонил токен плагина (llm.bbToken). Получить новый: bb plugin token newsdesk");
    }
    if (response.status === 404) throw new Error("На сервере bb не найден плагин newsdesk: он установлен и включён?");
    if (!response.ok) throw new Error(`Сервер bb ответил кодом ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    async run(llmRequest: LlmRequest): Promise<string> {
      const started = await request(
        "/llm",
        {
          method: "POST",
          body: JSON.stringify({
            task: llmRequest.task,
            model: llmRequest.model,
            reasoning: llmRequest.reasoning,
            prompt: llmRequest.prompt,
          }),
        },
        llmRequest.signal,
      );
      const jobId = started.jobId;
      if (typeof jobId !== "string") throw new Error("Сервер bb не принял запрос к модели");
      const deadline = Date.now() + (llmRequest.timeoutMs ?? 8 * 60_000);
      while (Date.now() < deadline) {
        await sleep(1500, llmRequest.signal);
        if (llmRequest.signal.aborted) throw new Error("Запрос к модели отменён");
        const result = await request(`/llm-result?job=${encodeURIComponent(jobId)}`, { method: "GET" }, llmRequest.signal);
        if (result.status === "done" && typeof result.text === "string") return result.text;
        if (result.status === "error") throw new Error(typeof result.error === "string" ? result.error : "Ошибка модели");
        if (result.status === "unknown") throw new Error("Сервер bb потерял запрос к модели (возможно, плагин перезапускался)");
      }
      throw new Error("Модель не ответила вовремя");
    },
  };
}
