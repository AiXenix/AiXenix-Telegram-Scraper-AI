// bb-plugin-newsdesk — admin page. One sidebar page with tabs: the queue of
// proposals, sources, history, the filtered list, settings and status.
// Everything is read and changed through the RPC contract in server.ts; the
// server tells the page to refetch over the "changed" realtime channel.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Config, EventRow, Overview, SourceView, StoryStatus, StoryView, rpcContract } from "./server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const REDACTED = "***";
const REJECT_REASONS = ["не по теме", "уже было", "слабая новость", "реклама"];

const STATUS_LABEL: Record<StoryStatus, string> = {
  candidate: "ждёт черновика",
  proposed: "ждёт решения",
  publishing: "публикуется",
  published: "опубликовано",
  rejected: "отклонено",
  filtered: "отсеяно",
  own: "уже было на канале",
  failed: "не получилось",
};

const BOT_LABEL: Record<Overview["bot"]["state"], string> = {
  off: "выключен: нет токена",
  starting: "запускается",
  ok: "работает",
  bad_token: "Telegram не принимает токен",
  conflict: "бота опрашивает другая программа",
  error: "нет связи с Telegram",
};

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs an action, tracking "busy" and surfacing a failure as text. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

function ErrorLine({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint === undefined ? null : <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** The draft as Telegram will show it. The server has already reduced it to Telegram's safe tag subset. */
function DraftPreview({ html }: { html: string }) {
  const safe = useMemo(() => html.replace(/<a href=/gu, '<a target="_blank" rel="noreferrer noopener" href='), [html]);
  return (
    <div
      className="whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

function StoryCard({ story, rpc, onChanged }: { story: StoryView; rpc: Rpc; onChanged: () => void }) {
  const { busy, error, run, clearError } = useAction();
  const [mode, setMode] = useState<"view" | "edit" | "instruct" | "reject">("view");
  const [text, setText] = useState("");
  const [showSources, setShowSources] = useState(false);
  const decide = (action: "publish" | "reject" | "regenerate" | "restore", extra: { reason?: string | null; instruction?: string | null } = {}) =>
    run(action, async () => {
      await rpc.call("story_decide", { id: story.id, action, ...extra });
      setMode("view");
      onChanged();
    });
  const waiting = story.status === "proposed" && !story.rewriting;
  const firstSource = story.sources[0];
  return (
    <article className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">№{story.id}</span>
        <Badge variant={story.status === "failed" ? "destructive" : story.status === "proposed" ? "default" : "secondary"}>
          {story.rewriting ? "готовится новый вариант" : STATUS_LABEL[story.status]}
        </Badge>
        {story.score === null ? null : <span className="text-xs text-muted-foreground">оценка {story.score}</span>}
        {story.draftVersion > 1 ? <span className="text-xs text-muted-foreground">вариант {story.draftVersion}</span> : null}
        {story.hasMedia ? <span className="text-xs text-muted-foreground">с медиа</span> : null}
        <span className="ml-auto text-xs text-muted-foreground">{formatTime(story.decidedAt ?? story.createdAt)}</span>
      </header>
      <h3 className="text-sm font-semibold leading-snug">{story.title}</h3>
      {story.draftHtml === null || mode === "edit" ? null : <DraftPreview html={story.draftHtml} />}
      {story.draftHtml === null ? <p className="text-sm text-muted-foreground">{story.summary}</p> : null}
      {mode === "edit" ? (
        <div className="space-y-2">
          <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={10} aria-label="Текст поста" />
          <p className="text-xs text-muted-foreground">
            Разметка Telegram: &lt;b&gt;, &lt;i&gt;, &lt;code&gt;, &lt;a href="адрес"&gt;. С медиа текст не длиннее 1024 знаков.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy !== null || text.trim() === ""}
              onClick={() =>
                run("save", async () => {
                  await rpc.call("story_set_draft", { id: story.id, html: text });
                  setMode("view");
                  onChanged();
                })
              }
            >
              Сохранить текст
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}
      {mode === "instruct" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Что изменить: короче, убрать последний абзац, добавить ссылку…"
            aria-label="Указание редактора"
            className="min-w-64 flex-1"
          />
          <Button size="sm" disabled={busy !== null || text.trim() === ""} onClick={() => decide("regenerate", { instruction: text.trim() })}>
            Переписать
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
            Отмена
          </Button>
        </div>
      ) : null}
      {mode === "reject" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Причина:</span>
          {REJECT_REASONS.map((reason) => (
            <Button key={reason} size="sm" variant="outline" disabled={busy !== null} onClick={() => decide("reject", { reason })}>
              {reason}
            </Button>
          ))}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => decide("reject", { reason: null })}>
            без причины
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
            Отмена
          </Button>
        </div>
      ) : null}
      {story.reason === null ? null : (
        <p className="text-xs text-muted-foreground">
          {story.status === "filtered" ? "Почему отсеяно" : "Почему предложено"}: {story.reason}
        </p>
      )}
      {story.decisionReason === null ? null : <p className="text-xs text-muted-foreground">Причина отказа: {story.decisionReason}</p>}
      {story.draftNote === null ? null : <p className="text-xs text-muted-foreground">Заметка автора: {story.draftNote}</p>}
      <ErrorLine>{story.lastError}</ErrorLine>
      <ErrorLine>{error}</ErrorLine>
      {mode === "view" ? (
        <div className="flex flex-wrap items-center gap-2">
          {waiting ? (
            <>
              <Button size="sm" disabled={busy !== null} onClick={() => decide("publish")}>
                <Icon name="newsdesk-send" className="size-4" />
                Разместить
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  clearError();
                  setMode("reject");
                }}
              >
                Отказать
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => decide("regenerate")}>
                Другой вариант
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setText("");
                  setMode("instruct");
                }}
              >
                Указать, что изменить
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setText(story.draftHtml ?? "");
                  setMode("edit");
                }}
              >
                Править текст
              </Button>
            </>
          ) : null}
          {story.status === "candidate" ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => decide("reject", { reason: null })}>
              Отказать
            </Button>
          ) : null}
          {story.status === "filtered" || story.status === "rejected" || story.status === "failed" ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => decide("restore")}>
              Вернуть в работу
            </Button>
          ) : null}
          {story.publishedUrl === null ? null : (
            <a className="text-sm text-primary underline" href={story.publishedUrl} target="_blank" rel="noreferrer noopener">
              Открыть в канале
            </a>
          )}
          {story.sources.length === 0 ? null : (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowSources((value) => !value)}>
              {showSources ? "Скрыть источники" : `Источники: ${story.sources.length}`}
            </Button>
          )}
        </div>
      ) : null}
      {!showSources && firstSource !== undefined && mode === "view" ? (
        <p className="text-xs text-muted-foreground">
          Источник:{" "}
          {firstSource.url === "" ? (
            "ваше сообщение боту"
          ) : (
            <a className="underline" href={firstSource.url} target="_blank" rel="noreferrer noopener">
              @{firstSource.handle}
            </a>
          )}
          {story.sources.length > 1 ? ` и ещё ${story.sources.length - 1}` : ""}
        </p>
      ) : null}
      {showSources
        ? story.sources.map((source) => (
            <div key={source.url + source.postedAt} className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
              <div className="flex flex-wrap gap-2 text-muted-foreground">
                {source.url === "" ? (
                  <span>ваше сообщение боту</span>
                ) : (
                  <a className="underline" href={source.url} target="_blank" rel="noreferrer noopener">
                    @{source.handle}
                  </a>
                )}
                <span>{formatTime(source.postedAt)}</span>
                {source.media.length === 0 ? null : (
                  <span>
                    медиа: {source.media.length}
                    {source.media.every((item) => item.sendable) ? "" : " (файл недоступен)"}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words">{source.text}</p>
            </div>
          ))
        : null}
    </article>
  );
}

function StoryList({
  rpc,
  statuses,
  empty,
  searchable,
  refreshKey,
  onChanged,
}: {
  rpc: Rpc;
  statuses: StoryStatus[];
  empty: ReactNode;
  searchable?: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [stories, setStories] = useState<StoryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const statusKey = statuses.join(",");
  useEffect(() => {
    let cancelled = false;
    rpc.call("stories_list", { statuses, limit, ...(query.trim() === "" ? {} : { query: query.trim() }) }).then(
      (result) => {
        if (cancelled) return;
        setStories(result.stories);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
    // statuses is rebuilt on every render; statusKey carries its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, statusKey, limit, query, refreshKey]);
  return (
    <div className="space-y-3">
      {searchable === true ? (
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по заголовку и тексту" aria-label="Поиск" />
      ) : null}
      <ErrorLine>{error}</ErrorLine>
      {stories === null ? (
        <Empty>Загрузка…</Empty>
      ) : stories.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        stories.map((story) => <StoryCard key={`${story.id}:${story.draftVersion}:${story.status}`} story={story} rpc={rpc} onChanged={onChanged} />)
      )}
      {stories !== null && stories.length >= limit && limit < 100 ? (
        <Button variant="outline" size="sm" onClick={() => setLimit(100)}>
          Показать больше
        </Button>
      ) : null}
    </div>
  );
}

function SourcesTab({ rpc, refreshKey, onChanged }: { rpc: Rpc; refreshKey: number; onChanged: () => void }) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [input, setInput] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    rpc.call("sources_list").then((result) => setSources(result.sources), () => undefined);
  }, [rpc, refreshKey]);
  const add = () =>
    run("add", async () => {
      const failures: string[] = [];
      for (const item of input.split(/[\s,]+/u).filter(Boolean)) {
        try {
          await rpc.call("source_add", { input: item });
        } catch (cause) {
          failures.push(`${item}: ${errorText(cause)}`);
        }
      }
      onChanged();
      if (failures.length > 0) throw new Error(failures.join("; "));
      setInput("");
    });
  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim() !== "") void add();
        }}
      >
        <Input value={input} onChange={(event) => setInput(event.target.value)} placeholder="@канал или ссылка t.me/канал, можно несколько через пробел" aria-label="Новый источник" />
        <Button type="submit" disabled={busy !== null || input.trim() === ""}>
          <Icon name="Plus" className="size-4" />
          Добавить
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            run("collect", async () => {
              await rpc.call("collect_now");
            })
          }
        >
          Проверить сейчас
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Читаются открытые каналы через веб-версию t.me. Закрытые каналы и каналы с выключенным веб-просмотром так не прочитать.
      </p>
      <ErrorLine>{error}</ErrorLine>
      {sources === null ? (
        <Empty>Загрузка…</Empty>
      ) : sources.length === 0 ? (
        <Empty>Список пуст. Добавьте каналы, за которыми нужно следить.</Empty>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {sources.map((source) => (
            <li key={source.handle} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <Switch
                checked={source.enabled}
                aria-label={`Следить за @${source.handle}`}
                onCheckedChange={(enabled) =>
                  run(`toggle:${source.handle}`, async () => {
                    await rpc.call("source_set_enabled", { handle: source.handle, enabled });
                    onChanged();
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <a className="font-medium underline-offset-2 hover:underline" href={`https://t.me/${source.handle}`} target="_blank" rel="noreferrer noopener">
                  @{source.handle}
                </a>
                {source.title === null ? null : <span className="ml-2 text-muted-foreground">{source.title}</span>}
                <div className="text-xs text-muted-foreground">
                  последний пост {formatTime(source.lastPostAt)} · проверен {formatTime(source.lastCheckedAt)} · собрано {source.posts}, опубликовано{" "}
                  {source.published}, отклонено {source.rejected}
                </div>
                {source.lastError === null ? null : <div className="text-xs text-destructive">{source.lastError}</div>}
              </div>
              {confirmRemove === source.handle ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`remove:${source.handle}`, async () => {
                        await rpc.call("source_remove", { handle: source.handle });
                        setConfirmRemove(null);
                        onChanged();
                      })
                    }
                  >
                    Убрать
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
                    Отмена
                  </Button>
                </>
              ) : (
                <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={`Убрать @${source.handle}`} onClick={() => setConfirmRemove(source.handle)}>
                  <Icon name="Trash2" className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

function NumberField({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Number.parseInt(event.target.value, 10))}
      />
    </Field>
  );
}

function SettingsTab({ rpc, overview, onChanged }: { rpc: Rpc; overview: Overview | null; onChanged: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => {
    rpc.call("config_get").then((result) => {
      setConfig(result.config);
      setDirty(false);
    }, () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  if (config === null) return <Empty>Загрузка…</Empty>;
  const edit = (mutate: (draft: Config) => void) => {
    const draft = structuredClone(config);
    mutate(draft);
    setConfig(draft);
    setDirty(true);
    setSaved(false);
  };
  const save = (next: unknown = config) =>
    run("save", async () => {
      const result = await rpc.call("config_set", { config: next });
      setConfig(result.config);
      setDirty(false);
      setSaved(true);
      onChanged();
    });
  const secretField = (label: string, hint: string, value: string, onChange: (value: string) => void) => (
    <Field label={label} hint={value === REDACTED ? `${hint} Сейчас задан; чтобы заменить, вставьте новый.` : hint}>
      <Input
        type="password"
        autoComplete="off"
        value={value === REDACTED ? "" : value}
        placeholder={value === REDACTED ? "задан" : "не задан"}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
  const runTest = (which: "filter" | "writer") =>
    run(`test:${which}`, async () => {
      setTest("Спрашиваю модель…");
      const result = await rpc.call("llm_test", { which });
      setTest(`${result.model}: ${result.ok ? `отвечает за ${(result.ms / 1000).toFixed(1)} с` : `ошибка — ${result.text}`}`);
    });
  return (
    <div className="space-y-4">
      <Section title="Telegram">
        {secretField("Токен бота", "Из @BotFather. Бот должен быть администратором канала с правом публикации.", config.telegram.botToken, (value) =>
          edit((draft) => {
            draft.telegram.botToken = value;
          }),
        )}
        <Field label="Канал для публикаций" hint="Адрес вида @name.">
          <Input value={config.telegram.channel} onChange={(event) => edit((draft) => { draft.telegram.channel = event.target.value; })} />
        </Field>
        <p className="text-sm">
          Владелец:{" "}
          {config.telegram.ownerChatId === null ? (
            <span>
              не привязан. Отправьте боту <code className="rounded bg-muted px-1">/start {overview?.owner.pairingCode ?? "код"}</code>
            </span>
          ) : (
            <span>
              привязан (id {config.telegram.ownerChatId}){" "}
              <Button size="sm" variant="ghost" onClick={() => edit((draft) => { draft.telegram.ownerChatId = null; })}>
                Отвязать
              </Button>
            </span>
          )}
        </p>
      </Section>

      <Section title="Модели">
        <Field label="Откуда брать модели" hint="По подпискам bb запросы идут скрытыми тредами Codex и расходуют лимиты подключённых аккаунтов.">
          <select className={selectClass} value={config.llm.backend} onChange={(event) => edit((draft) => { draft.llm.backend = event.target.value as Config["llm"]["backend"]; })}>
            <option value="auto">Автоматически (в bb — подписки bb)</option>
            <option value="bb-threads">Подписки bb</option>
            <option value="openai">Свой ключ API (совместимый с OpenAI)</option>
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Модель для отбора">
            <Input value={config.llm.filterModel} onChange={(event) => edit((draft) => { draft.llm.filterModel = event.target.value; })} />
          </Field>
          <Field label="Модель для текстов">
            <Input value={config.llm.writerModel} onChange={(event) => edit((draft) => { draft.llm.writerModel = event.target.value; })} />
          </Field>
          <Field label="Глубина рассуждений для отбора">
            <select className={selectClass} value={config.llm.filterReasoning} onChange={(event) => edit((draft) => { draft.llm.filterReasoning = event.target.value; })}>
              {["low", "medium", "high"].map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </Field>
          <Field label="Глубина рассуждений для текстов">
            <select className={selectClass} value={config.llm.writerReasoning} onChange={(event) => edit((draft) => { draft.llm.writerReasoning = event.target.value; })}>
              {["low", "medium", "high"].map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </Field>
        </div>
        {config.llm.backend === "openai" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Адрес API" hint="Заканчивается на /v1.">
              <Input value={config.llm.apiBaseUrl} onChange={(event) => edit((draft) => { draft.llm.apiBaseUrl = event.target.value; })} />
            </Field>
            {secretField("Ключ API", "", config.llm.apiKey, (value) => edit((draft) => { draft.llm.apiKey = value; }))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null || dirty} onClick={() => runTest("filter")}>Проверить модель отбора</Button>
          <Button size="sm" variant="outline" disabled={busy !== null || dirty} onClick={() => runTest("writer")}>Проверить модель текстов</Button>
          {test === null ? null : <span className="text-sm text-muted-foreground">{test}</span>}
        </div>
      </Section>

      <Section title="Редакция">
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={config.editorial.proposeAll} onCheckedChange={(value) => edit((draft) => { draft.editorial.proposeAll = value; })} aria-label="Предлагать все новости" className="mt-0.5" />
          <span>
            Предлагать все новости
            <span className="block text-xs text-muted-foreground">
              Включено: сервис не решает, что интересно, и отсеивает только повторы уже известного новостного повода. Выключено: он ещё отбрасывает то, что не подходит
              описанию канала или набрало оценку ниже порога.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={config.editorial.skipAds} onCheckedChange={(value) => edit((draft) => { draft.editorial.skipAds = value; })} aria-label="Не предлагать рекламу" />
          Не предлагать посты с пометкой рекламы (#реклама, erid)
        </label>
        <Field label="О канале" hint={config.editorial.proposeAll ? "Видит автор черновика. На отбор не влияет, пока включено «Предлагать все новости»." : "По этому описанию модель решает, подходит ли новость."}>
          <Textarea rows={4} value={config.editorial.channelProfile} onChange={(event) => edit((draft) => { draft.editorial.channelProfile = event.target.value; })} />
        </Field>
        <Field label="Стиль постов" hint="Так пишутся черновики. Последние посты канала модель видит как примеры.">
          <Textarea rows={7} value={config.editorial.styleGuide} onChange={(event) => edit((draft) => { draft.editorial.styleGuide = event.target.value; })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Подпись в конце поста">
            <Input value={config.editorial.footer} onChange={(event) => edit((draft) => { draft.editorial.footer = event.target.value; })} />
          </Field>
          <NumberField label="Порог оценки" hint={config.editorial.proposeAll ? "Не используется, пока включено «Предлагать все новости»." : "Ниже — в отсев. От 0 до 100."} min={0} max={100} value={config.editorial.minScore} onChange={(value) => edit((draft) => { draft.editorial.minScore = value; })} />
          <NumberField label="Предложений в сутки, не больше" hint="Столько же может одновременно ждать решения." min={1} max={200} value={config.editorial.maxProposalsPerDay} onChange={(value) => edit((draft) => { draft.editorial.maxProposalsPerDay = value; })} />
          <NumberField label="Ждать решения, часов" hint="Потом предложение уходит в отсев." min={1} max={720} value={config.editorial.proposalTtlHours} onChange={(value) => edit((draft) => { draft.editorial.proposalTtlHours = value; })} />
          <NumberField label="Не брать посты старше, часов" min={1} max={336} value={config.editorial.maxAgeHours} onChange={(value) => edit((draft) => { draft.editorial.maxAgeHours = value; })} />
          <NumberField label="Помнить решения, дней" hint="Опубликованное и отклонённое не предлагается повторно." min={1} max={180} value={config.editorial.memoryDays} onChange={(value) => edit((draft) => { draft.editorial.memoryDays = value; })} />
          <NumberField label="Минимум текста в посте, знаков" hint="Для постов без фото и видео." min={0} max={2000} value={config.editorial.minTextLength} onChange={(value) => edit((draft) => { draft.editorial.minTextLength = value; })} />
        </div>
      </Section>

      <Section title="Расписание">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <label className="flex items-center gap-2">
            <Switch checked={config.schedule.collectEnabled} onCheckedChange={(value) => edit((draft) => { draft.schedule.collectEnabled = value; })} aria-label="Сбор включён" />
            Собирать новости
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={config.schedule.pipelineEnabled} onCheckedChange={(value) => edit((draft) => { draft.schedule.pipelineEnabled = value; })} aria-label="Отбор и черновики включены" />
            Отбирать и писать черновики
          </label>
          <div className="w-56">
            <NumberField label="Проверять каналы каждые, минут" min={1} max={120} value={config.schedule.pollMinutes} onChange={(value) => edit((draft) => { draft.schedule.pollMinutes = value; })} />
          </div>
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy !== null || !dirty} onClick={() => save()}>Сохранить настройки</Button>
        {dirty ? <Button variant="ghost" onClick={load}>Отменить изменения</Button> : null}
        {saved && !dirty ? <span className="text-sm text-muted-foreground">Сохранено</span> : null}
      </div>
      <ErrorLine>{error}</ErrorLine>

      <Section title="Один файл настроек">
        <p className="text-sm text-muted-foreground">
          Те же настройки подходят отдельному скрипту на ПК: сохраните их как newsdesk.config.json. Токены в выгрузке скрыты звёздочками; с ними файл выдаёт
          команда <code className="rounded bg-muted px-1">bb newsdesk config export --with-secrets</code>.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setTransfer(JSON.stringify(config, null, 2))}>Показать настройки как JSON</Button>
          {transfer === null ? null : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(transfer);
                  } catch {
                    void run("import", async () => {
                      throw new Error("Это не JSON: проверьте скобки и запятые");
                    });
                    return;
                  }
                  void save(parsed);
                }}
              >
                Загрузить из поля ниже
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTransfer(null)}>Скрыть</Button>
            </>
          )}
        </div>
        {transfer === null ? null : <Textarea rows={14} className="font-mono text-xs" value={transfer} onChange={(event) => setTransfer(event.target.value)} aria-label="Настройки в JSON" />}
      </Section>
    </div>
  );
}

function StatusTab({ rpc, overview, refreshKey }: { rpc: Rpc; overview: Overview | null; refreshKey: number }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const { busy, error, run } = useAction();
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    rpc.call("events", { limit: 60, problemsOnly }).then((result) => setEvents(result.events), () => undefined);
  }, [rpc, problemsOnly, refreshKey]);
  if (overview === null) return <Empty>Загрузка…</Empty>;
  const rows: [string, string][] = [
    ["Канал", overview.channel || "не задан"],
    ["Бот", `${BOT_LABEL[overview.bot.state]}${overview.bot.username === null ? "" : ` (@${overview.bot.username})`}`],
    ["Владелец", overview.owner.paired ? "привязан" : `не привязан, код для /start: ${overview.owner.pairingCode ?? "—"}`],
    ["Сбор", `${overview.collector.enabled ? "включён" : "выключен"}, раз в ${overview.collector.pollMinutes} мин, последний ${formatTime(overview.collector.lastRunAt)}`],
    ["Отбор и черновики", overview.pipeline.enabled ? (overview.pipeline.pausedUntil === null ? "включены" : `пауза после ошибки до ${formatTime(overview.pipeline.pausedUntil)}`) : "выключены"],
    ["Источники", `${overview.sources.enabled} из ${overview.sources.total}, не читается ${overview.sources.failing}`],
    ["Память канала", `${overview.ownPosts} своих постов`],
    ["Модели", overview.llm.backend === "bb-threads" ? "подписки bb" : overview.llm.backend],
  ];
  return (
    <div className="space-y-4">
      <Section title="Сейчас">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run("memory", async () => {
                const result = await rpc.call("own_refresh", { pages: 10 });
                setMemoryNote(`Добавлено постов в память: ${result.added}`);
              })
            }
          >
            Перечитать свой канал
          </Button>
          {confirmReset ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null}
                onClick={() =>
                  run("reset", async () => {
                    const result = await rpc.call("reset_from_now");
                    setConfirmReset(false);
                    setMemoryNote(`Сброшено: сюжетов ${result.stories}, постов ${result.posts}. Слежу за каналами с этого момента.`);
                  })
                }
              >
                Да, забыть всё собранное
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                Отмена
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmReset(true)}>
              Начать с чистого листа
            </Button>
          )}
          {memoryNote === null ? null : <span className="text-sm text-muted-foreground">{memoryNote}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          «Начать с чистого листа» удаляет собранные посты, предложения, отсев и историю (отклонённые сюжеты тоже) и убирает неразобранные предложения из Telegram.
          Дальше предлагается только то, что выйдет в каналах после этого момента. Опубликованное остаётся в памяти как посты вашего канала.
        </p>
        <ErrorLine>{error}</ErrorLine>
      </Section>
      <Section title="Запросы к моделям за сутки">
        {overview.llm.stats.length === 0 ? (
          <p className="text-sm text-muted-foreground">Запросов пока не было.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">Задача</th>
                <th className="py-1 font-normal">Модель</th>
                <th className="py-1 text-right font-normal">Запросов</th>
                <th className="py-1 text-right font-normal">Ошибок</th>
                <th className="py-1 text-right font-normal">В среднем</th>
              </tr>
            </thead>
            <tbody>
              {overview.llm.stats.map((stat) => (
                <tr key={`${stat.task}:${stat.model}`} className="border-t border-border">
                  <td className="py-1">{stat.task}</td>
                  <td className="py-1">{stat.model}</td>
                  <td className="py-1 text-right tabular-nums">{stat.runs}</td>
                  <td className="py-1 text-right tabular-nums">{stat.failed}</td>
                  <td className="py-1 text-right tabular-nums">{(stat.avgMs / 1000).toFixed(1)} с</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Журнал">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={problemsOnly} onCheckedChange={setProblemsOnly} aria-label="Только проблемы" />
          Только проблемы
        </label>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Записей нет.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {events.map((event) => (
              <li key={event.id} className={cn("flex gap-3", event.level === "error" && "text-destructive")}>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(event.at)}</span>
                <span className="break-words">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function NewsdeskPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  useEffect(() => {
    rpc.call("overview").then(
      (result) => {
        setOverview(result);
        setLoadError(null);
      },
      (cause: unknown) => setLoadError(errorText(cause)),
    );
  }, [rpc, refreshKey]);
  useRealtime("changed", refresh);
  const counts = overview?.counts ?? {};
  const waiting = (counts.proposed ?? 0) + (counts.candidate ?? 0) + (counts.failed ?? 0);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <ErrorLine>{loadError}</ErrorLine>
        {overview === null || overview.problems.length === 0 ? null : (
          <ul className="space-y-1 rounded-lg border border-border bg-card px-4 py-3 text-sm">
            {overview.problems.map((problem) => (
              <li key={problem} className="flex gap-2">
                <Icon name="newsdesk-alert" className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>{problem}</span>
              </li>
            ))}
          </ul>
        )}
        <Tabs defaultValue="queue">
          <TabsList className="flex-wrap">
            <TabsTrigger value="queue">Очередь{waiting > 0 ? ` · ${waiting}` : ""}</TabsTrigger>
            <TabsTrigger value="sources">Источники{overview === null ? "" : ` · ${overview.sources.total}`}</TabsTrigger>
            <TabsTrigger value="history">История</TabsTrigger>
            <TabsTrigger value="filtered">Отсев{(counts.filtered ?? 0) > 0 ? ` · ${counts.filtered}` : ""}</TabsTrigger>
            <TabsTrigger value="settings">Настройки</TabsTrigger>
            <TabsTrigger value="status">Состояние</TabsTrigger>
          </TabsList>
          <TabsContent value="queue">
            <StoryList
              rpc={rpc}
              statuses={["proposed", "publishing", "candidate", "failed"]}
              refreshKey={refreshKey}
              onChanged={refresh}
              empty={
                overview !== null && overview.newPosts > 0
                  ? `Предложений пока нет. Ждут разбора постов: ${overview.newPosts}.`
                  : "Сейчас ничего не ждёт решения. Новые предложения появятся здесь и придут в Telegram."
              }
            />
          </TabsContent>
          <TabsContent value="sources">
            <SourcesTab rpc={rpc} refreshKey={refreshKey} onChanged={refresh} />
          </TabsContent>
          <TabsContent value="history">
            <StoryList rpc={rpc} statuses={["published", "rejected"]} searchable refreshKey={refreshKey} onChanged={refresh} empty="Решений пока не было." />
          </TabsContent>
          <TabsContent value="filtered">
            <StoryList
              rpc={rpc}
              statuses={["filtered"]}
              searchable
              refreshKey={refreshKey}
              onChanged={refresh}
              empty="Отсев пуст. Сюда попадают повторы уже известных новостей, с пометкой, что именно они повторяют."
            />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab rpc={rpc} overview={overview} onChanged={refresh} />
          </TabsContent>
          <TabsContent value="status">
            <StatusTab rpc={rpc} overview={overview} refreshKey={refreshKey} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/** Icons bb has no built-in glyph for, drawn in the same stroke style as its own. */
function strokeIcon(paths: ReactNode) {
  return function StrokeIcon({ className }: { className?: string }) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        {paths}
      </svg>
    );
  };
}

const NewspaperIcon = strokeIcon(
  <>
    <path d="M15 18h-5" />
    <path d="M18 14h-8" />
    <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" />
    <rect width="8" height="4" x="10" y="6" rx="1" />
  </>,
);
const SendIcon = strokeIcon(
  <>
    <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
    <path d="m21.854 2.147-10.94 10.939" />
  </>,
);
const AlertIcon = strokeIcon(
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>,
);

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "newsdesk-newspaper", component: NewspaperIcon });
  app.experimental_icons.register({ name: "newsdesk-send", component: SendIcon });
  app.experimental_icons.register({ name: "newsdesk-alert", component: AlertIcon });
  app.slots.navPanel({
    id: "newsdesk",
    title: "Редакция новостей",
    icon: "newsdesk-newspaper",
    path: "newsdesk",
    component: NewsdeskPage,
  });
});
