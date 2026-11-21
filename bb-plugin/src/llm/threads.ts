// Runs one model request as a hidden bb thread on the Codex provider, so the
// work is billed to the subscriptions connected to bb (Account Pooler) and no
// API key is involved. One request = one short-lived thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "../db.ts";
import type { LlmRunner } from "../platform.ts";
import { NO_TOOLS_PREAMBLE } from "./shared.ts";

export { NO_TOOLS_PREAMBLE };

export const LLM_PROVIDER_ID = "codex";

interface Pending {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export function createThreadLlm(
  bb: BbPluginApi,
  store: Store,
  resolveProjectId: () => Promise<string>,
): LlmRunner {
  const pending = new Map<string, Pending>();

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const entry = pending.get(thread.id);
    if (entry === undefined) return;
    if (lastAssistantText !== null && lastAssistantText.trim() !== "") {
      entry.resolve(lastAssistantText);
      return;
    }
    bb.sdk.threads.output({ threadId: thread.id }).then(
      (output) => {
        const text = typeof output === "string" ? output : JSON.stringify(output);
        if (text.trim() === "") entry.reject(new Error("Модель вернула пустой ответ"));
        else entry.resolve(text);
      },
      (cause: unknown) => entry.reject(cause instanceof Error ? cause : new Error(String(cause))),
    );
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    pending.get(thread.id)?.reject(new Error(`Тред модели завершился с ошибкой: ${error ?? "без описания"}`));
  });
  bb.events.on("interaction.pending", ({ thread }) => {
    // The agent asked for an approval or an answer. Nobody is there to give one.
    pending.get(thread.id)?.reject(new Error("Модель запросила подтверждение вместо ответа"));
  });

  return {
    async run(request) {
      const startedAt = Date.now();
      let threadId: string | null = null;
      try {
        const projectId = await resolveProjectId();
        const project = await bb.sdk.projects.get({ projectId });
        const thread = await bb.sdk.threads.spawn({
          projectId,
          environment:
            project.kind === "personal"
              ? { type: "host", workspace: { type: "personal" } }
              : { type: "project-default" },
          providerId: LLM_PROVIDER_ID,
          model: request.model,
          reasoningLevel: request.reasoning,
          permissionMode: "accept-edits",
          prompt: request.prompt,
          title: `Редакция: ${request.task}`,
          visibility: "hidden",
          pluginMetadata: { task: request.task },
        });
        threadId = thread.id;
        const spawnedId = thread.id;
        const text = await new Promise<string>((resolve, reject) => {
          const timeoutMs = request.timeoutMs ?? 8 * 60_000;
          const timer = setTimeout(
            () => reject(new Error(`Модель не ответила за ${Math.round(timeoutMs / 1000)} с`)),
            timeoutMs,
          );
          const onAbort = () => reject(new Error("Запрос к модели отменён"));
          request.signal.addEventListener("abort", onAbort, { once: true });
          const finish = () => {
            clearTimeout(timer);
            request.signal.removeEventListener("abort", onAbort);
            pending.delete(spawnedId);
          };
          pending.set(spawnedId, {
            resolve: (value) => {
              finish();
              resolve(value);
            },
            reject: (error) => {
              finish();
              reject(error);
            },
          });
          if (request.signal.aborted) onAbort();
        });
        store.logLlmRun({
          task: request.task,
          model: request.model,
          threadId,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return text;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        store.logLlmRun({
          task: request.task,
          model: request.model,
          threadId,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: message.slice(0, 500),
        });
        throw cause instanceof Error ? cause : new Error(message);
      } finally {
        if (threadId !== null) {
          const id = threadId;
          pending.delete(id);
          // Take the thread out of active lists and free the agent process, whatever happened.
          const cleanup = (async () => {
            await bb.sdk.threads.archive({ threadId: id }).catch(() => undefined);
            await bb.sdk.threads.stop({ threadId: id }).catch(() => undefined);
          })();
          // On shutdown or reload the caller must return at once; anything the
          // cleanup does not finish is picked up by stopStrayWorkerThreads at the next start.
          if (!request.signal.aborted) await cleanup;
        }
      }
    },
  };
}

/**
 * Stops and archives worker threads left behind by a previous run (a reload
 * or a crash in the middle of a request). Call once at start.
 */
export async function stopStrayWorkerThreads(bb: BbPluginApi): Promise<number> {
  const threads = await bb.sdk.threads.list({
    originPluginId: bb.pluginId,
    archived: false,
    includeHidden: true,
    limit: 100,
    offset: 0,
  });
  let stopped = 0;
  for (const thread of threads) {
    await bb.sdk.threads.archive({ threadId: thread.id }).catch(() => undefined);
    await bb.sdk.threads.stop({ threadId: thread.id }).catch(() => undefined);
    stopped += 1;
  }
  return stopped;
}

/** Deletes this plugin's finished worker threads older than `maxAgeMs`. */
export async function pruneWorkerThreads(bb: BbPluginApi, maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (let page = 0; page < 20; page += 1) {
    const result = await bb.sdk.threads.list({
      originPluginId: bb.pluginId,
      archived: true,
      includeHidden: true,
      limit: 100,
      offset: 0,
    });
    const old = result.filter((thread) => thread.createdAt < cutoff);
    if (old.length === 0) break;
    for (const thread of old) {
      await bb.sdk.threads.delete({ threadId: thread.id, childThreadsConfirmed: true }).then(
        () => {
          removed += 1;
        },
        () => undefined,
      );
    }
    if (old.length < result.length) break;
  }
  return removed;
}
