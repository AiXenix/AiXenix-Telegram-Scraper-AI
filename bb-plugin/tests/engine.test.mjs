// End-to-end scenario for the engine with everything outside it faked: channel
// pages, the model, and the Telegram Bot API (a strict local stand-in). It
// walks the whole life of a story: collect, filter, merge repeats, draft,
// propose with buttons, publish, reject, rewrite, manual forward.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveConfig } from "../src/config.ts";
import { Store, migrate } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { startMockTelegram } from "./support/mock-telegram.mjs";

const OWNER = 111;
const CHANNEL = "@test_channel";
const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

/** Fake channels: handle -> posts. Tests add posts as the scenario goes. */
const channels = {
  alpha: [
    { id: 101, minutesAgo: 50, photo: "https://cdn.test/a101.jpg", html: 'Компания Foo выпустила модель Bar 2 с открытыми весами. Она работает на обычном ноутбуке и пишет код. Подробности в <a href="https://foo.ai/bar2">блоге</a>.' },
    { id: 102, minutesAgo: 45, html: "Биткоин упал ниже шестидесяти тысяч долларов на фоне распродажи акций технологических компаний, сообщают биржи." },
  ],
  beta: [
    { id: 201, minutesAgo: 40, html: 'Foo представила Bar 2: открытые веса, запуск на ноутбуке, генерация кода. <a href="https://foo.ai/bar2">Источник</a>' },
    { id: 202, minutesAgo: 35, video: "https://cdn.test/b202.mp4", html: "Вышел инструмент Baz для совместной работы ИИ-агентов: до шестнадцати агентов проверяют выводы друг друга и вместе правят файлы." },
  ],
  delta: [{ id: 301, minutesAgo: 30, html: "Просто пост в канале дельта про новые видеокарты для обучения нейросетей и их цены." }],
};

function channelPage(handle, posts) {
  const items = posts
    .map(
      (post) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${handle}/${post.id}">
        ${post.photo ? `<a class="tgme_widget_message_photo_wrap" style="background-image:url('${post.photo}')"></a>` : ""}
        ${post.video ? `<a class="tgme_widget_message_video_player"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn.test/thumb.jpg')"></i><video src="${post.video}"></video></a>` : ""}
        <div class="tgme_widget_message_text js-message_text">${post.html}</div>
        <span class="tgme_widget_message_views">1.2K</span>
        <a class="tgme_widget_message_date" href="https://t.me/${handle}/${post.id}"><time datetime="${iso(post.minutesAgo)}"></time></a>
      </div></div>`,
    )
    .join("\n");
  return `<html><body><div class="tgme_channel_info"><div class="tgme_channel_info_header_title">Канал ${handle}</div></div>${items}</body></html>`;
}

let mock;
let engine;
let store;
let config;
let controller;
const llmCalls = [];

/** Routes the engine's HTTP: channel pages and media are faked, the Bot API goes to the local stand-in. */
function fakeFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "t.me") {
    const handle = url.pathname.replace(/^\/s\//u, "");
    const posts = channels[handle];
    if (posts === undefined) return Promise.resolve(new Response("", { status: 302, headers: { location: `https://t.me/${handle}` } }));
    const afterId = url.searchParams.get("after");
    const beforeId = url.searchParams.get("before");
    let visible = [...posts].sort((left, right) => left.id - right.id);
    if (afterId !== null) visible = visible.filter((post) => post.id > Number(afterId)).slice(0, 20);
    else if (beforeId !== null) visible = visible.filter((post) => post.id < Number(beforeId)).slice(-20);
    else visible = visible.slice(-20);
    return Promise.resolve(new Response(channelPage(handle, visible), { status: 200 }));
  }
  if (url.hostname === "cdn.test") {
    if (url.pathname.includes("missing")) return Promise.resolve(new Response("gone", { status: 404 }));
    return Promise.resolve(new Response(new Uint8Array(2048).fill(7), { status: 200, headers: { "content-length": "2048" } }));
  }
  return fetch(input, init);
}

/** A rule-based stand-in for the model. */
const fakeLlm = {
  async run(request) {
    llmCalls.push(request);
    if (request.task === "отбор") {
      const verdicts = [];
      const seen = new Map();
      for (const match of request.prompt.matchAll(/<post id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/post>(?:\nПохожие сюжеты из памяти для поста \d+:\n((?:- \[S\d+\][^\n]*\n?)+))?/gu)) {
        const id = Number(match[1]);
        const text = match[2];
        const memory = /\[S(\d+)\]/u.exec(match[3] ?? "");
        const topic = /Bar 2/u.test(text) ? "bar2" : /Baz/u.test(text) ? "baz" : `own-${id}`;
        if (/Биткоин/u.test(text)) {
          verdicts.push({ id, verdict: "skip", duplicate_of: null, score: null, title: "Биткоин упал", summary: "Курс упал.", reason: "не по теме" });
        } else if (memory !== null) {
          verdicts.push({ id, verdict: "duplicate", duplicate_of: `S${memory[1]}`, score: null, title: null, summary: null, reason: "тот же сюжет" });
        } else if (seen.has(topic)) {
          verdicts.push({ id, verdict: "duplicate", duplicate_of: `P${seen.get(topic)}`, score: null, title: null, summary: null, reason: "тот же сюжет в списке" });
        } else {
          seen.set(topic, id);
          const weak = /видеокарты/u.test(text);
          verdicts.push({ id, verdict: "new", duplicate_of: null, score: weak ? 40 : 85, title: `Сюжет ${topic}`, summary: text.slice(0, 80), reason: weak ? "на грани темы" : "важная новость" });
        }
      }
      return JSON.stringify(verdicts);
    }
    if (request.task === "черновик") {
      const instruction = /УКАЗАНИЕ РЕДАКТОРА[^\n]*\n([^\n]+)/u.exec(request.prompt)?.[1];
      const another = request.prompt.includes("Редактор попросил другой вариант");
      const subject = /Bar 2/u.test(request.prompt) ? "Bar 2" : /Baz/u.test(request.prompt) ? "Baz" : "материал";
      const lead = instruction ? `По указанию «${instruction}»` : another ? "Другой вариант" : "Первый вариант";
      return JSON.stringify({
        text: `<b>${lead}: ${subject}</b>\n\nКороткий пересказ про ${subject} своими словами. Подробности — <a href="https://foo.ai/bar2">в блоге</a>.`,
        comment: "",
      });
    }
    throw new Error(`unexpected task ${request.task}`);
  },
};

const mockState = async () => (await fetch(`${mock.url}/_test/state`)).json();
const inject = (update) => fetch(`${mock.url}/_test/update`, { method: "POST", body: JSON.stringify(update) });
const ownerMessage = (fields) => inject({ message: { chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, ...fields } });
/** Presses a button. `data` without a tag gets the tag of the engine under test, as a real button would carry. */
const press = (data, messageId) =>
  inject({ callback_query: { id: `cb-${data}-${Date.now()}`, from: { id: OWNER, is_bot: false, first_name: "Owner" }, data: data.includes("@") ? data : `${data}@${store.getState("instance_tag")}`, message: { message_id: messageId, chat: { id: OWNER, type: "private" }, date: 0 } } });

async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs pipeline steps until there is nothing left to do. */
async function drain() {
  for (let index = 0; index < 20; index += 1) {
    if (!(await engine.pipelineStep(controller.signal))) return;
  }
  throw new Error("pipeline did not settle");
}

const toOwner = (state) => state.messages.filter((message) => message.chat_id === String(OWNER));
const toChannel = (state) => state.messages.filter((message) => message.chat_id === CHANNEL);
const controlOf = (state, storyId) =>
  [...toOwner(state)].reverse().find((message) => (message.keyboard ?? []).flat().some((button) => (button.callback_data ?? "").startsWith(`p:${storyId}@`)));
const storyByTitle = (title) => store.db.prepare("SELECT * FROM stories WHERE title = ?").get(title);

before(async () => {
  mock = await startMockTelegram();
  const db = new DatabaseSync(":memory:");
  migrate(db);
  store = new Store(db);
  config = resolveConfig({
    telegram: { botToken: "TEST", channel: CHANNEL, apiBase: mock.url },
    sources: ["@alpha", "@beta"],
    schedule: { pollMinutes: 1 },
    // This scenario covers the mode that also judges relevance; the propose-everything mode has its own test file.
    editorial: { proposeAll: false, footer: "@MyChannel" },
  });
  // Starting points before the posts in the fake channels, so the first round collects them.
  store.addSource("alpha", "Канал alpha", 100);
  store.addSource("beta", "Канал beta", 200);
  const configStore = {
    load: async () => config,
    save: async (next) => {
      config = next;
    },
  };
  const platform = { runtime: "standalone", fetch: fakeFetch, log() {}, changed() {} };
  engine = new Engine({ store, platform, configStore, llm: fakeLlm });
  controller = new AbortController();
  void engine.runBot(controller.signal);
});

after(async () => {
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mock.close();
});

test("a stranger is refused and the owner pairs with the code", async () => {
  await inject({ message: { chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false, first_name: "X" }, text: "/start 000000" } });
  await until(async () => (await mockState()).messages.some((m) => m.chat_id === "999" && /не привязан/u.test(m.visible)), "refusal to a wrong code");
  assert.equal(config.telegram.ownerChatId, null);

  await ownerMessage({ text: `/start ${engine.pairingCode()}` });
  await until(() => config.telegram.ownerChatId === OWNER, "owner paired");
  await until(async () => toOwner(await mockState()).some((m) => /теперь я работаю с вами/u.test(m.visible)), "pairing confirmation");

  await inject({ message: { chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false, first_name: "X" }, text: "привет" } });
  await until(async () => (await mockState()).messages.some((m) => m.chat_id === "999" && /только со своим владельцем/u.test(m.visible)), "refusal after pairing");
});

test("collecting stores new posts once", async () => {
  const first = await engine.collectOnce(controller.signal);
  assert.deepEqual(first.map((result) => [result.handle, result.stored, result.error]), [["alpha", 2, null], ["beta", 2, null]]);
  const second = await engine.collectOnce(controller.signal);
  assert.deepEqual(second.map((result) => result.stored), [0, 0]);
  assert.equal(store.countNewPosts(), 4);
});

test("triage merges the repeat, drops the off-topic post and queues two stories", async () => {
  await drain();
  const counts = store.countByStatus();
  assert.equal(counts.filtered, 2, "the bitcoin post and the repeat are in the filtered list");
  const repeat = store.db.prepare("SELECT * FROM stories WHERE duplicate_of IS NOT NULL").get();
  assert.match(repeat.reason, /^повтор \(уже в очереди\): №\d+ «Сюжет bar2»/u, "the repeat says what it repeats");
  assert.equal(counts.proposed, 2, "two stories got drafts");
  const bar = storyByTitle("Сюжет bar2");
  assert.deepEqual(store.postsOfStory(bar.id).map((post) => post.source_handle).sort(), ["alpha", "beta"], "both channels point at one story");
  assert.equal(llmCalls.filter((call) => call.task === "отбор").length, 1, "one filter request for the batch");
  assert.equal(llmCalls.filter((call) => call.task === "отбор")[0].model, "gpt-6.1-terra");
  assert.equal(llmCalls.filter((call) => call.task === "черновик")[0].model, "gpt-6.2-sol");
});

test("proposals reach the owner as a preview with media and a message with buttons", async () => {
  const bar = storyByTitle("Сюжет bar2");
  const baz = storyByTitle("Сюжет baz");
  const state = await until(async () => {
    const current = await mockState();
    return controlOf(current, bar.id) && controlOf(current, baz.id) ? current : null;
  }, "both proposals delivered");
  const barControl = controlOf(state, bar.id);
  const barPreview = toOwner(state).find((message) => message.message_id === barControl.reply_to);
  assert.equal(barPreview.media.kind, "photo");
  assert.equal(barPreview.media.source, "upload");
  assert.match(barPreview.visible, /^Первый вариант: Bar 2/u);
  assert.match(barPreview.visible, /@MyChannel$/u, "the signature is the last line");
  assert.match(barControl.visible, /оценка 85/u);
  assert.match(barControl.visible, /Источник: @alpha и ещё 1/u);
  assert.deepEqual(barControl.keyboard.flat().map((button) => button.text), ["✅ Разместить", "❌ Отказать", "🔁 Другой вариант", "✏️ Править"]);
  const bazPreview = toOwner(state).find((message) => message.message_id === controlOf(state, baz.id).reply_to);
  assert.equal(bazPreview.media.kind, "video");
});

test("the Publish button posts to the channel, reusing the uploaded media", async () => {
  const bar = storyByTitle("Сюжет bar2");
  const control = controlOf(await mockState(), bar.id);
  await press(`p:${bar.id}`, control.message_id);
  const state = await until(async () => {
    const current = await mockState();
    return toChannel(current).length === 1 ? current : null;
  }, "post in the channel");
  const published = toChannel(state)[0];
  assert.equal(published.media.source, "file_id", "the preview's file is reused, not uploaded again");
  assert.match(published.visible, /^Первый вариант: Bar 2/u);
  const after = store.getStory(bar.id);
  assert.equal(after.status, "published");
  assert.equal(after.published_url, `https://t.me/test_channel/${published.message_id}`);
  const proposalIds = [control.reply_to, control.message_id];
  const outcome = await until(async () => {
    const owner = toOwner(await mockState());
    if (owner.some((m) => proposalIds.includes(m.message_id))) return null;
    return owner.find((m) => new RegExp(`^✅ Размещено №${bar.id}: «Первый вариант: Bar 2`, "u").test(m.visible));
  }, "preview and buttons replaced by one outcome line");
  assert.equal(outcome.keyboard, null);
  assert.match(outcome.text, /<a href="https:\/\/t\.me\/test_channel\/\d+">открыть<\/a>/u);
  assert.ok(store.hasOwnPost(published.message_id), "the published post is remembered as ours");
});

test("the Reject button records the decision and then the reason", async () => {
  const baz = storyByTitle("Сюжет baz");
  const control = controlOf(await mockState(), baz.id);
  const proposalIds = [control.reply_to, control.message_id];
  await press(`r:${baz.id}`, control.message_id);
  await until(() => store.getStory(baz.id).status === "rejected", "story rejected");
  const line = await until(async () => {
    const owner = toOwner(await mockState());
    if (owner.some((m) => proposalIds.includes(m.message_id))) return null;
    return owner.find((m) => new RegExp(`^❌ Отклонено №${baz.id}: «`, "u").test(m.visible));
  }, "proposal replaced by one line with reason buttons");
  assert.deepEqual(line.keyboard.flat().map((button) => button.text), ["не по теме", "уже было", "слабая новость", "реклама"]);
  await press(`rr:${baz.id}:2`, line.message_id);
  await until(() => store.getStory(baz.id).decision_reason === "слабая новость", "reason saved");
  const final = await until(async () => {
    const message = toOwner(await mockState()).find((m) => m.message_id === line.message_id);
    return / — слабая новость$/u.test(message.visible) ? message : null;
  }, "the same line now shows the reason");
  assert.equal(final.keyboard, null);
});

test("the same news from other channels is not proposed again after a decision", async () => {
  const proposalsBefore = llmCalls.filter((call) => call.task === "черновик").length;
  channels.alpha.push({ id: 103, minutesAgo: 5, html: 'Ещё раз про Bar 2 от Foo: открытые веса и запуск на ноутбуке, генерация кода. <a href="https://foo.ai/bar2">Блог</a>' });
  channels.beta.push({ id: 203, minutesAgo: 4, html: "Инструмент Baz для совместной работы ИИ-агентов: шестнадцать агентов проверяют выводы друг друга и правят файлы." });
  channels.beta.push({ id: 204, minutesAgo: 3, html: "В продаже появились новые видеокарты для обучения нейросетей, цены выросли на десять процентов." });
  await engine.collectOnce(controller.signal);
  await drain();
  assert.equal(llmCalls.filter((call) => call.task === "черновик").length, proposalsBefore, "no new drafts were written");
  assert.equal(store.postsOfStory(storyByTitle("Сюжет bar2").id).length, 3, "the repeat joined the published story");
  assert.equal(store.postsOfStory(storyByTitle("Сюжет baz").id).length, 2, "the repeat joined the rejected story");
  const weak = store.db.prepare("SELECT * FROM stories WHERE score = 40").get();
  assert.equal(weak.status, "filtered", "a story below the score threshold goes to the filtered list");
});

test("a filtered story can be restored and then gets a draft", async () => {
  const weak = store.db.prepare("SELECT * FROM stories WHERE score = 40").get();
  await engine.decide(weak.id, "restore");
  await drain();
  assert.equal(store.getStory(weak.id).status, "proposed");
  await until(async () => controlOf(await mockState(), weak.id), "restored story proposed to the owner");
  await engine.decide(weak.id, "reject", { reason: "не по теме" });
});

test("a forwarded post is drafted out of turn; Another variant and Edit work", async () => {
  await ownerMessage({
    caption: "Компания Qux показала робота-курьера с нейросетью, который сам строит маршрут по городу и объезжает пробки.",
    photo: [{ file_id: "fwd-small", width: 90, height: 90 }, { file_id: "fwd-big", width: 1280, height: 720 }],
    forward_origin: { type: "channel", chat: { id: -100500, type: "channel", username: "Gamma", title: "Gamma" }, message_id: 77, date: Math.floor(now / 1000) - 600 },
  });
  await until(async () => toOwner(await mockState()).some((m) => /Принял, готовлю пост/u.test(m.visible)), "manual material accepted");
  const story = store.db.prepare("SELECT * FROM stories WHERE manual = 1 AND score = 100 ORDER BY id DESC").get();
  assert.equal(story.status, "candidate");
  await drain();
  let state = await until(async () => {
    const current = await mockState();
    return controlOf(current, story.id) ? current : null;
  }, "manual story proposed");
  let control = controlOf(state, story.id);
  let preview = toOwner(state).find((message) => message.message_id === control.reply_to);
  assert.equal(preview.media.fileId, "fwd-big", "the forwarded photo is sent by its file id");
  assert.match(control.visible, /прислано вручную/u);
  assert.match(control.visible, /Источник: @gamma/u);

  // Another variant
  await press(`a:${story.id}`, control.message_id);
  await until(async () => /готовлю другой вариант/u.test(toOwner(await mockState()).find((m) => m.message_id === control.message_id).visible), "old proposal retired");
  await drain();
  state = await until(async () => {
    const current = await mockState();
    const fresh = controlOf(current, story.id);
    return fresh && fresh.message_id !== control.message_id ? current : null;
  }, "second variant proposed");
  control = controlOf(state, story.id);
  preview = toOwner(state).find((message) => message.message_id === control.reply_to);
  assert.match(preview.visible, /^Другой вариант/u);
  assert.match(control.visible, /вариант 2/u);

  // Edit by instruction
  await press(`e:${story.id}`, control.message_id);
  await until(async () => controlKeyboardHas(await mockState(), control.message_id, `ei:${story.id}`), "edit menu shown");
  await press(`ei:${story.id}`, control.message_id);
  await until(async () => toOwner(await mockState()).some((m) => /что изменить в №/u.test(m.visible)), "instruction prompt");
  await ownerMessage({ text: "сделай короче" });
  await until(async () => toOwner(await mockState()).some((m) => /Переписываю №/u.test(m.visible)), "instruction accepted");
  await drain();
  state = await until(async () => {
    const current = await mockState();
    const fresh = controlOf(current, story.id);
    return fresh && fresh.message_id !== control.message_id ? current : null;
  }, "third variant proposed");
  control = controlOf(state, story.id);
  preview = toOwner(state).find((message) => message.message_id === control.reply_to);
  assert.match(preview.visible, /^По указанию «сделай короче»/u);

  // Edit by own text, keeping formatting
  await press(`et:${story.id}`, control.message_id);
  await until(async () => toOwner(await mockState()).some((m) => /новый текст для №/u.test(m.visible)), "own text prompt");
  await ownerMessage({ text: "Мой текст про курьера и ссылка", entities: [{ type: "bold", offset: 0, length: 9 }, { type: "text_link", offset: 24, length: 6, url: "https://qux.example/robot" }] });
  await until(() => store.getStory(story.id).draft_version === 4, "own text saved");
  assert.equal(store.getStory(story.id).draft_html, '<b>Мой текст</b> про курьера и <a href="https://qux.example/robot">ссылка</a>');
  await drain();
  state = await until(async () => {
    const current = await mockState();
    const fresh = controlOf(current, story.id);
    return fresh && fresh.message_id !== control.message_id ? current : null;
  }, "own text proposed");
  control = controlOf(state, story.id);
  await press(`p:${story.id}`, control.message_id);
  await until(() => store.getStory(story.id).status === "published", "manual story published");
  const published = toChannel(await mockState()).at(-1);
  assert.equal(published.visible, "Мой текст про курьера и ссылка");
  assert.equal(published.media.source, "file_id");
});

function controlKeyboardHas(state, messageId, data) {
  const message = toOwner(state).find((candidate) => candidate.message_id === messageId);
  return (message?.keyboard ?? []).flat().some((button) => (button.callback_data ?? "").startsWith(`${data}@`));
}

test("forwarding something already published is recognized", async () => {
  const text = "Компания Foo выпустила модель Bar 2 с открытыми весами. Она работает на обычном ноутбуке и пишет код. Подробности в блоге.";
  const link = { type: "text_link", offset: text.indexOf("блоге"), length: 5, url: "https://foo.ai/bar2" };
  const stories = store.db.prepare("SELECT COUNT(*) AS n FROM stories").get().n;
  // The very message the collector already saw.
  await ownerMessage({ text, entities: [link], forward_origin: { type: "channel", chat: { id: -100501, type: "channel", username: "alpha" }, message_id: 101, date: Math.floor(now / 1000) - 3000 } });
  await until(async () => toOwner(await mockState()).filter((m) => /уже есть на канале/u.test(m.visible)).length === 1, "already published notice for the same message");
  // The same text reposted by a channel we do not follow.
  await ownerMessage({ text, entities: [link], forward_origin: { type: "channel", chat: { id: -100777, type: "channel", username: "reposter" }, message_id: 5, date: Math.floor(now / 1000) - 100 } });
  await until(async () => toOwner(await mockState()).filter((m) => /уже есть на канале/u.test(m.visible)).length === 2, "already published notice for the same text");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM stories").get().n, stories, "no new story was created");
});

test("forwarding a post the filter dropped brings it back to the front of the queue", async () => {
  const dropped = store.db.prepare("SELECT * FROM stories WHERE title = 'Биткоин упал'").get();
  assert.equal(dropped.status, "filtered");
  await ownerMessage({
    text: "Биткоин упал ниже шестидесяти тысяч долларов на фоне распродажи акций технологических компаний, сообщают биржи.",
    forward_origin: { type: "channel", chat: { id: -100501, type: "channel", username: "alpha" }, message_id: 102, date: Math.floor(now / 1000) - 2700 },
  });
  await until(() => store.getStory(dropped.id).status === "candidate", "dropped story requeued");
  assert.equal(store.getStory(dropped.id).manual, 1);
  await drain();
  assert.equal(store.getStory(dropped.id).status, "proposed");
  await engine.decide(dropped.id, "reject", { reason: "не по теме" });
});

test("commands: sources, add, pause, remove, status", async () => {
  await ownerMessage({ text: "/sources" });
  await until(async () => toOwner(await mockState()).some((m) => /Источники \(2\)/u.test(m.visible) && /@alpha/u.test(m.visible)), "sources listed");

  await ownerMessage({ text: "/add https://t.me/delta @nosuchchannel" });
  const reply = await until(async () => toOwner(await mockState()).find((m) => /Добавил: @delta/u.test(m.visible)), "channel added");
  assert.match(reply.visible, /Не получилось:\n@nosuchchannel: Канал @nosuchchannel не найден/u);
  assert.deepEqual(config.sources, ["@alpha", "@beta", "@delta"], "the sources list in the config is updated");
  assert.ok(store.getSourceByHandle("delta"));

  await engine.collectOnce(controller.signal, "delta");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_handle = 'delta'").get().n, 0, "a new channel starts from now: its old post is not collected");
  channels.delta.push({ id: 302, minutesAgo: 0, html: "Свежий пост в канале дельта про открытый набор данных для обучения роботов." });
  await engine.collectOnce(controller.signal, "delta");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_handle = 'delta' AND state = 'new'").get().n, 1, "the post published after adding is collected");
  await ownerMessage({ text: "/pause @delta" });
  await until(() => store.getSourceByHandle("delta").enabled === 0, "channel paused");
  assert.deepEqual(config.sources.at(-1), { handle: "@delta", enabled: false });

  await ownerMessage({ text: "/remove @delta" });
  await until(() => store.getSourceByHandle("delta") === undefined, "channel removed");
  assert.deepEqual(config.sources, ["@alpha", "@beta"]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE source_handle = 'delta' AND state = 'new'").get().n, 0, "pending posts of a removed channel are dropped");

  await ownerMessage({ text: "/status" });
  const status = await until(async () => toOwner(await mockState()).find((m) => /^Состояние/u.test(m.visible)), "status shown");
  assert.match(status.visible, /Источников: 2 из 2/u);
  assert.match(status.visible, /Опубликовано: 2, отклонено: 3/u);
});

test("status from a second process shows the running copy's bot state", async () => {
  const other = new Engine({ store, platform: { runtime: "standalone", fetch: fakeFetch, log() {}, changed() {} }, configStore: { load: async () => config, save: async () => {} }, llm: fakeLlm });
  const overview = await other.overview("test");
  assert.equal(overview.bot.state, "ok", "read from the state the running copy saved");
  assert.equal(overview.bot.username, "newsdesk_test_bot");
  assert.ok(!overview.problems.some((problem) => /не запущен/u.test(problem)));
  store.setState("runtime", { ...store.getState("runtime"), at: Date.now() - 10 * 60_000, botState: "bad_token" });
  const stale = await other.overview("test");
  assert.ok(stale.problems.some((problem) => /Сервис сейчас не запущен/u.test(problem)), "an old heartbeat means the service is down");
  assert.ok(stale.problems.some((problem) => /Telegram не принимает токен/u.test(problem)));
});

test("a publication the channel refuses leaves the story waiting and tells the owner why", async () => {
  channels.alpha.push({ id: 105, minutesAgo: 1, html: "Лаборатория Zed открыла набор данных для обучения моделей распознавания речи на редких языках, он доступен всем." });
  await engine.collectOnce(controller.signal);
  await drain();
  const story = store.db.prepare("SELECT * FROM stories WHERE status = 'proposed' ORDER BY id DESC").get();
  const control = await until(async () => controlOf(await mockState(), story.id), "proposal delivered");
  config = { ...config, telegram: { ...config.telegram, channel: "" } };
  await press(`p:${story.id}`, control.message_id);
  await until(async () => toOwner(await mockState()).some((m) => /Не задан канал для публикации/u.test(m.visible)), "owner told about the failure");
  assert.equal(store.getStory(story.id).status, "proposed");
  config = { ...config, telegram: { ...config.telegram, channel: CHANNEL } };
  await press(`p:${story.id}`, control.message_id);
  await until(() => store.getStory(story.id).status === "published", "published on the second try");
});

test("a proposal nobody decided on in time moves to the filtered list", async () => {
  channels.alpha.push({ id: 107, minutesAgo: 1, html: "Университет Wex выложил открытый курс по обучению языковых моделей с подкреплением, лекции и задания доступны бесплатно." });
  await engine.collectOnce(controller.signal);
  await drain();
  const story = store.db.prepare("SELECT * FROM stories WHERE status = 'proposed' ORDER BY id DESC").get();
  const control = await until(async () => controlOf(await mockState(), story.id), "proposal delivered");
  assert.equal(await engine.expireStaleProposals(), 0, "a fresh proposal stays");
  store.db.prepare("UPDATE stories SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 49 * 3_600_000).toISOString(), story.id);
  assert.equal(await engine.expireStaleProposals(), 1);
  const after = store.getStory(story.id);
  assert.equal(after.status, "filtered");
  assert.match(after.reason, /^не рассмотрено за 48 ч/u);
  const owner = toOwner(await mockState());
  assert.ok(!owner.some((message) => message.message_id === control.message_id || message.message_id === control.reply_to), "the proposal is gone from the chat");
  const line = owner.find((message) => new RegExp(`^⌛ Не рассмотрено за 48 ч, убрано в отсев №${story.id}: «`, "u").test(message.visible));
  assert.ok(line, "one line says what happened");
});

test("a button from another copy of the service is refused and changes nothing", async () => {
  channels.alpha.push({ id: 109, minutesAgo: 1, html: "Компания Vox открыла исходный код синтезатора речи, который клонирует голос по десяти секундам записи и работает офлайн." });
  await engine.collectOnce(controller.signal);
  await drain();
  const story = store.db.prepare("SELECT * FROM stories WHERE status = 'proposed' ORDER BY id DESC").get();
  const control = await until(async () => controlOf(await mockState(), story.id), "proposal delivered");
  const answersBefore = (await mockState()).answers.length;
  await press(`p:${story.id}@ffffff`, control.message_id);
  const answer = await until(async () => (await mockState()).answers[answersBefore], "refusal shown");
  assert.match(answer.text, /другая копия сервиса/u);
  assert.equal(answer.alert, true);
  assert.equal(store.getStory(story.id).status, "proposed");
  // A button from before tags existed still works.
  await inject({ callback_query: { id: "legacy", from: { id: OWNER, is_bot: false, first_name: "Owner" }, data: `r:${story.id}`, message: { message_id: control.message_id, chat: { id: OWNER, type: "private" }, date: 0 } } });
  await until(() => store.getStory(story.id).status === "rejected", "legacy button accepted");
});

test("the status reports a bot that cannot post to the channel", async () => {
  const problems = async () => (await engine.overview("test")).problems.join(" | ");
  assert.doesNotMatch(await problems(), /не может публиковать|не добавлен/u);
  config = { ...config, telegram: { ...config.telegram, channel: "@no_post_right" } };
  await until(async () => /Бот не может публиковать в @no_post_right/u.test(await problems()), "missing post right reported", 8000);
  config = { ...config, telegram: { ...config.telegram, channel: "@not_a_member" } };
  await until(async () => /Бот не добавлен в @not_a_member/u.test(await problems()), "bot outside the channel reported", 8000);
  config = { ...config, telegram: { ...config.telegram, channel: CHANNEL } };
  await until(async () => !/не может публиковать|не добавлен/u.test(await problems()), "problem cleared", 8000);
});

test("media that cannot be downloaded does not block the proposal", async () => {
  channels.beta.push({ id: 206, minutesAgo: 1, photo: "https://cdn.test/missing.jpg", html: "Стартап Yak представил чип для запуска больших языковых моделей на телефоне без подключения к интернету и облаку." });
  await engine.collectOnce(controller.signal);
  await drain();
  const story = store.db.prepare("SELECT * FROM stories WHERE status = 'proposed' ORDER BY id DESC").get();
  const state = await until(async () => {
    const current = await mockState();
    return controlOf(current, story.id) ? current : null;
  }, "proposal delivered without media");
  const control = controlOf(state, story.id);
  const preview = toOwner(state).find((message) => message.message_id === control.reply_to);
  assert.equal(preview.media, undefined, "the preview is text only");
  assert.match(control.visible, /Медиа не приложено/u);
});
