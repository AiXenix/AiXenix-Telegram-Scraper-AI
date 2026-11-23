// The default mode: every new story is proposed, only repeats of a known
// story are dropped, and a reset starts watching from the present moment.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveConfig } from "../src/config.ts";
import { Store, migrate } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { startMockTelegram } from "./support/mock-telegram.mjs";

const OWNER = 111;
const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

const channels = {
  chanone: [{ id: 10, minutesAgo: 600, html: "Старый пост, который вышел до начала наблюдения: обзор нейросетей прошлой недели." }],
  chantwo: [{ id: 50, minutesAgo: 500, html: "Ещё один старый пост до начала наблюдения про генерацию картинок." }],
};

function page(handle, posts) {
  return `<html><body><div class="tgme_channel_info"><div class="tgme_channel_info_header_title">${handle}</div></div>${posts
    .map(
      (post) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${handle}/${post.id}">
      <div class="tgme_widget_message_text js-message_text">${post.html}</div>
      <a class="tgme_widget_message_date" href="https://t.me/${handle}/${post.id}"><time datetime="${iso(post.minutesAgo)}"></time></a></div></div>`,
    )
    .join("")}</body></html>`;
}

function fakeFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : String(input));
  if (url.hostname === "t.me") {
    const handle = url.pathname.replace(/^\/s\//u, "");
    const posts = channels[handle] ?? [];
    const afterId = url.searchParams.get("after");
    const list = [...posts].sort((a, b) => a.id - b.id).filter((post) => afterId === null || post.id > Number(afterId));
    return Promise.resolve(new Response(page(handle, list.slice(-20)), { status: 200 }));
  }
  return fetch(input, init);
}

const calls = [];
/** The model sees "Claude" posts as one news hook: the first is new, the rest repeat it. */
const llm = {
  async run(request) {
    calls.push(request);
    if (request.task === "черновик") return JSON.stringify({ text: "Черновик поста.", comment: "" });
    const memory = /\[S(\d+)\][^\n]*Anthropic выпустила новые модели Claude/u.exec(request.prompt);
    const verdicts = [];
    let firstClaude = null;
    for (const match of request.prompt.matchAll(/<post id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/post>/gu)) {
      const id = Number(match[1]);
      const text = match[2];
      if (/Claude/u.test(text) && /модел/u.test(text)) {
        if (memory !== null) verdicts.push({ id, verdict: "duplicate", duplicate_of: `S${memory[1]}`, reason: "тот же релиз Claude" });
        else if (firstClaude !== null) verdicts.push({ id, verdict: "duplicate", duplicate_of: `P${firstClaude}`, reason: "тот же релиз" });
        else {
          firstClaude = id;
          verdicts.push({ id, verdict: "new", title: "Anthropic выпустила новые модели Claude", summary: "Релиз.", reason: "" });
        }
      } else {
        verdicts.push({ id, verdict: "new", title: text.slice(0, 60), summary: text.slice(0, 80), reason: "" });
      }
    }
    return JSON.stringify(verdicts);
  },
};

let mock;
let engine;
let store;
let config;
const controller = new AbortController();

before(async () => {
  mock = await startMockTelegram();
  const db = new DatabaseSync(":memory:");
  migrate(db);
  store = new Store(db);
  config = resolveConfig({
    telegram: { botToken: "TEST", channel: "@test_channel", apiBase: mock.url, ownerChatId: OWNER },
    sources: ["@chanone", "@chantwo"],
  });
  engine = new Engine({
    store,
    platform: { runtime: "standalone", fetch: fakeFetch, log() {}, changed() {} },
    configStore: { load: async () => config, save: async (next) => { config = next; } },
    llm,
  });
});

after(async () => {
  controller.abort();
  await mock.close();
});

async function drain() {
  for (let index = 0; index < 20; index += 1) if (!(await engine.pipelineStep(controller.signal))) return;
}
const state = async () => (await fetch(`${mock.url}/_test/state`)).json();

test("a new source starts from the present: older posts are not collected", async () => {
  await engine.collectOnce(controller.signal);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
});

test("a channel that was empty when added gets its first post collected", async () => {
  channels.chanempty = [];
  config = { ...config, sources: [...config.sources, "@chanempty"] };
  await engine.collectOnce(controller.signal);
  assert.equal(store.getSourceByHandle("chanempty").cursor, 0);
  channels.chanempty.push({ id: 1, minutesAgo: 0, html: "Самый первый пост нового канала: открыт набор данных для распознавания жестов." });
  await engine.collectOnce(controller.signal);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_handle = 'chanempty'").get().n, 1);
  // Leave the scenario below as it was: drop this channel and its post again.
  config = { ...config, sources: config.sources.filter((source) => source !== "@chanempty") };
  store.db.prepare("DELETE FROM posts WHERE source_handle = 'chanempty'").run();
  await engine.syncSources();
});

test("a channel that could not be read when added starts from the moment it first can be", async () => {
  const id = store.addSource("chanlater", null, -1).id;
  channels.chanlater = [{ id: 7, minutesAgo: 1, html: "Пост, который вышел до первого успешного чтения канала." }];
  config = { ...config, sources: [...config.sources, "@chanlater"] };
  await engine.collectOnce(controller.signal);
  assert.equal(store.getSource(id).cursor, 7);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_handle = 'chanlater'").get().n, 0);
  config = { ...config, sources: config.sources.filter((source) => source !== "@chanlater") };
  await engine.syncSources();
});

test("everything new is proposed; a weak or off-topic post is not judged away", async () => {
  channels.chanone.push({ id: 11, minutesAgo: 5, html: "Биткоин упал ниже шестидесяти тысяч долларов, сообщают биржи." });
  channels.chanone.push({ id: 12, minutesAgo: 4, html: "Мем про нейросети, которые рисуют лишние пальцы." });
  channels.chantwo.push({ id: 51, minutesAgo: 3, html: "Anthropic выпустила новые модели Claude: обновлены все три версии." });
  await engine.collectOnce(controller.signal);
  await drain();
  const counts = store.countByStatus();
  assert.equal(counts.proposed, 3, "all three posts are proposed");
  assert.equal(counts.filtered ?? 0, 0);
  const filterCall = calls.find((call) => call.task === "отбор");
  assert.doesNotMatch(filterCall.prompt, /"skip"|"score"/u);
});

test("after a decision on a news hook, other posts about it are dropped as repeats", async () => {
  const claude = store.db.prepare("SELECT * FROM stories WHERE title LIKE 'Anthropic%'").get();
  store.updateStory(claude.id, { status: "published", decided_at: new Date().toISOString() });
  channels.chanone.push({ id: 13, minutesAgo: 2, html: "Новые модели Claude умеют работать с компьютером и писать код быстрее прежних." });
  channels.chantwo.push({ id: 52, minutesAgo: 1, html: "Цены на новые модели Claude: тарифы остались прежними, как сообщает Anthropic." });
  channels.chantwo.push({ id: 53, minutesAgo: 1, html: "Google показала новый генератор видео с длительностью роликов до минуты." });
  await engine.collectOnce(controller.signal);
  await drain();
  const repeats = store.db.prepare("SELECT * FROM stories WHERE duplicate_of = ?").all(claude.id);
  assert.equal(repeats.length, 2, "both Claude follow-ups are repeats of the published story");
  for (const repeat of repeats) {
    assert.equal(repeat.status, "filtered");
    assert.match(repeat.reason, new RegExp(`^повтор \\(уже опубликовано на канале\\): №${claude.id}`, "u"));
  }
  assert.ok(store.db.prepare("SELECT * FROM stories WHERE title LIKE 'Google показала%' AND status = 'proposed'").get(), "an unrelated story is still proposed");
  assert.equal(store.postsOfStory(claude.id).length, 3, "the original story lists every post about it");
});

test("a reset forgets everything, clears the chat and watches from now on", async () => {
  await engine.pipelineStep(controller.signal);
  const before = await state();
  const proposals = before.messages.filter((message) => message.chat_id === String(OWNER));
  assert.ok(proposals.length > 0, "proposals were delivered before the reset");
  store.addOwnPost(9001, new Date().toISOString(), "Пост с нашего канала", null);

  const decided = store.db.prepare("SELECT proposal_message_ids, source_message_id FROM stories WHERE status IN ('published', 'rejected')").all();
  // A decided story keeps its messages: the original news (if still there) and the outcome line or proposal.
  const decidedIds = decided.flatMap((row) => [...(row.source_message_id > 0 ? [row.source_message_id] : []), ...JSON.parse(row.proposal_message_ids ?? "[]")]);
  const result = await engine.resetFromNow(controller.signal);
  assert.ok(result.stories === 5 && result.posts === 6, JSON.stringify(result));
  assert.equal(result.messages, proposals.length - decidedIds.length, "every pending proposal was deleted from the chat");
  const after = await state();
  const left = after.messages.filter((message) => message.chat_id === String(OWNER)).map((message) => message.message_id);
  assert.deepEqual(left.sort(), [...decidedIds].sort(), "only messages of decided stories stay");
  assert.deepEqual(store.countByStatus(), { own: 1 }, "only the published story is left, as a post of the channel");
  assert.equal(store.db.prepare("SELECT status FROM stories WHERE title LIKE 'Anthropic%'").get().status, "own");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
  assert.ok(store.hasOwnPost(9001), "the memory of our own channel stays");

  // Only what appears after the reset comes in.
  await engine.collectOnce(controller.signal);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0, "nothing old comes back");
  channels.chanone.push({ id: 14, minutesAgo: 0, html: "Свежая новость после сброса: открыт исходный код нового агента для браузера." });
  channels.chantwo.push({ id: 54, minutesAgo: 0, html: "Ещё раз про новые модели Claude: они уже доступны в API, сообщила Anthropic." });
  await engine.collectOnce(controller.signal);
  await drain();
  assert.equal(store.countByStatus().proposed, 1, "the fresh story is proposed");
  assert.equal(store.countByStatus().filtered, 1, "a repeat of what was published before the reset is still dropped");
});
