// Live scenario, driven only through Telegram: it plays the owner against a
// running service (the bb plugin or the standalone script — it cannot tell
// which) whose bot talks to the local stand-in for the Bot API. Channels are
// read from the real t.me and the real model writes the drafts.
//
//   node live-scenario.mjs --mock http://127.0.0.1:8089 --code 123456 --label standalone [--footer @MyChannel]
//
// Exit code 0 when every step passed.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const MOCK = args.mock ?? "http://127.0.0.1:8089";
const OWNER = 111;
const CHANNEL = args.channel ?? "@test_channel";
const LABEL = args.label ?? "service";
const WAIT_PROPOSALS_MS = Number(args["proposal-timeout"] ?? 480_000);

const results = [];
const started = Date.now();
const elapsed = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;

async function step(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true });
    console.log(`${elapsed()}  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    return true;
  } catch (cause) {
    results.push({ name, ok: false });
    console.log(`${elapsed()}  FAIL  ${name}\n            ${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
}

const state = async () => (await fetch(`${MOCK}/_test/state`)).json();
const inject = (update) => fetch(`${MOCK}/_test/update`, { method: "POST", body: JSON.stringify(update) });
const say = (fields) => inject({ message: { chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, ...fields } });
let serviceTag = "";
/** Presses a button the way Telegram would: with the tag the service put on its buttons. */
const press = (callbackData, messageId) =>
  inject({ callback_query: { id: `cb-${Date.now()}-${Math.random()}`, from: { id: OWNER, is_bot: false, first_name: "Owner" }, data: serviceTag === "" ? callbackData : `${callbackData}@${serviceTag}`, message: { message_id: messageId, chat: { id: OWNER, type: "private" }, date: 0 } } });

async function until(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check(await state());
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`не дождался: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

const toOwner = (current) => current.messages.filter((message) => message.chat_id === String(OWNER));
const toChannel = (current) => current.messages.filter((message) => message.chat_id === CHANNEL);
const buttons = (message) => (message.keyboard ?? []).flat();
const data = (button) => button.callback_data ?? "";
/** The callback data of the button that starts with the given action and story, tag included. */
const buttonData = (message, prefix) => data(buttons(message).find((button) => data(button).startsWith(prefix)) ?? {});
/** Live proposals: control messages that still carry the Publish button. */
const openProposals = (current) =>
  toOwner(current)
    .filter((message) => buttons(message).some((button) => data(button).startsWith("p:")))
    .map((message) => ({ control: message, id: Number(/^p:(\d+)/u.exec(buttonData(message, "p:"))[1]), tag: buttonData(message, "p:").split("@")[1] ?? "" }));
const previewOf = (current, control) => toOwner(current).find((message) => message.message_id === control.reply_to);
const mark = async () => (await state()).messages.length;
const newOwnerMessage = (pattern, from) => (current) => toOwner({ messages: current.messages.slice(from) }).find((message) => pattern.test(message.visible ?? ""));

console.log(`Сценарий для «${LABEL}», Bot API: ${MOCK}`);

await step("привязка владельца по коду", async () => {
  if (!args.code) throw new Error("не передан --code");
  await say({ text: `/start ${args.code}` });
  await until(newOwnerMessage(/теперь я работаю с вами/u, 0), "подтверждение привязки");
});

await step("команда /status", async () => {
  const from = await mark();
  await say({ text: "/status" });
  const reply = await until(newOwnerMessage(/^Состояние/u, from), "ответ на /status");
  return reply.visible.split("\n")[1];
});

await step("команда /sources", async () => {
  const from = await mark();
  await say({ text: "/sources" });
  const reply = await until(newOwnerMessage(/^Источники \(\d+\)/u, from), "ответ на /sources");
  return reply.visible.split("\n")[0];
});

let proposals = [];
const gotProposals = await step("сервис сам собрал новости и прислал предложения", async () => {
  await say({ text: "/collect" });
  proposals = await until((current) => (openProposals(current).length >= 3 ? openProposals(current) : null), "три предложения с кнопками", WAIT_PROPOSALS_MS);
  serviceTag = proposals[0].tag;
  return `предложений: ${proposals.length}`;
});

if (gotProposals) {
  await step("предложение оформлено как пост: текст, подпись, лимиты, кнопки", async () => {
    const current = await state();
    for (const { control } of openProposals(current)) {
      const preview = previewOf(current, control);
      if (preview === undefined) throw new Error("у предложения нет предпросмотра");
      if (args.footer && !preview.visible.endsWith(args.footer)) throw new Error(`нет подписи ${args.footer} в конце: …${preview.visible.slice(-40)}`);
      if (preview.media !== undefined && preview.visible.length > 1024) throw new Error(`подпись к медиа ${preview.visible.length} знаков`);
      if (preview.visible.length < 150) throw new Error(`подозрительно короткий текст: ${preview.visible.length} знаков`);
      const labels = buttons(control).map((button) => button.text).join(" | ");
      if (labels !== "✅ Разместить | ❌ Отказать | 🔁 Другой вариант | ✏️ Править") throw new Error(`кнопки: ${labels}`);
      if (!/^№\d+ · (оценка \d+|прислано вручную|возвращено в работу)/u.test(control.visible)) throw new Error(`шапка: ${control.visible.split("\n")[0]}`);
    }
    const withMedia = openProposals(current).filter(({ control }) => previewOf(current, control).media !== undefined).length;
    return `с медиа: ${withMedia} из ${openProposals(current).length}`;
  });

  await step("кнопка «Разместить» публикует в канал тот же текст", async () => {
    const { control, id } = proposals[0];
    const before = toChannel(await state()).length;
    const expected = previewOf(await state(), control).visible;
    await press(`p:${id}`, control.message_id);
    const published = await until((current) => toChannel(current)[before], "пост в канале", 120_000);
    if (published.visible !== expected) throw new Error("текст в канале отличается от предпросмотра");
    await until((current) => !toOwner(current).some((message) => message.message_id === control.message_id) && toOwner(current).some((message) => new RegExp(`^✅ Размещено №${id}: «`, "u").test(message.visible)), "предложение заменено строкой «Размещено»");
    return `№${id}, ${published.media === undefined ? "без медиа" : `${published.media.kind}, ${published.media.source === "file_id" ? "файл взят из предпросмотра" : "загружен заново"}`}`;
  });

  await step("кнопка «Отказать» и причина отказа", async () => {
    const { control, id } = proposals[1];
    await press(`r:${id}`, control.message_id);
    const line = await until((current) => toOwner(current).find((message) => new RegExp(`^❌ Отклонено №${id}: «`, "u").test(message.visible)), "строка «Отклонено» с кнопками причины");
    await press(`rr:${id}:0`, line.message_id);
    await until((current) => / — не по теме$/u.test(toOwner(current).find((message) => message.message_id === line.message_id).visible), "причина записана");
    return `№${id}`;
  });

  await step("кнопка «Другой вариант» присылает новый текст", async () => {
    const { control, id } = proposals[2];
    const first = previewOf(await state(), control).visible;
    await press(`a:${id}`, control.message_id);
    const fresh = await until(
      (current) => openProposals(current).find((proposal) => proposal.id === id && proposal.control.message_id !== control.message_id),
      "второй вариант",
      240_000,
    );
    const second = previewOf(await state(), fresh.control).visible;
    if (second === first) throw new Error("второй вариант совпал с первым слово в слово");
    if (!/вариант 2/u.test(fresh.control.visible)) throw new Error("в шапке нет отметки «вариант 2»");
    proposals[2] = fresh;
    return `№${id}: было ${first.length} знаков, стало ${second.length}`;
  });

  await step("«Править» с указанием переписывает черновик", async () => {
    const { control, id } = proposals[2];
    const previous = previewOf(await state(), control).visible;
    await press(`e:${id}`, control.message_id);
    await until((current) => buttons(toOwner(current).find((message) => message.message_id === control.message_id)).some((button) => data(button).startsWith(`ei:${id}`)), "меню правки");
    const from = await mark();
    await press(`ei:${id}`, control.message_id);
    await until(newOwnerMessage(/что изменить в №/u, from), "приглашение написать указание");
    await say({ text: "Сократи вдвое, оставь только главное." });
    const fresh = await until(
      (current) => openProposals(current).find((proposal) => proposal.id === id && proposal.control.message_id !== control.message_id),
      "вариант по указанию",
      240_000,
    );
    const next = previewOf(await state(), fresh.control).visible;
    if (next.length >= previous.length) throw new Error(`текст не стал короче: ${previous.length} → ${next.length}`);
    proposals[2] = fresh;
    return `№${id}: ${previous.length} → ${next.length} знаков`;
  });

  await step("«Править» со своим текстом сохраняет его как есть", async () => {
    const { control, id } = proposals[2];
    await press(`e:${id}`, control.message_id);
    await until((current) => buttons(toOwner(current).find((message) => message.message_id === control.message_id)).some((button) => data(button).startsWith(`et:${id}`)), "меню правки");
    const from = await mark();
    await press(`et:${id}`, control.message_id);
    await until(newOwnerMessage(/новый текст для №/u, from), "приглашение прислать текст");
    const own = "Свой текст владельца с жирным словом и ссылкой.";
    await say({ text: own, entities: [{ type: "bold", offset: own.indexOf("жирным"), length: 6 }, { type: "text_link", offset: own.indexOf("ссылкой"), length: 7, url: "https://example.com/own" }] });
    const fresh = await until(
      (current) => openProposals(current).find((proposal) => proposal.id === id && proposal.control.message_id !== control.message_id),
      "предпросмотр своего текста",
      60_000,
    );
    const preview = previewOf(await state(), fresh.control);
    const source = preview.caption ?? preview.text;
    if (preview.visible !== own) throw new Error(`текст изменён: ${preview.visible}`);
    if (!source.includes("<b>жирным</b>") || !source.includes('<a href="https://example.com/own">ссылкой</a>')) throw new Error(`оформление потеряно: ${source}`);
    proposals[2] = fresh;
    return `№${id}`;
  });
}

await step("команды /add и /remove меняют список каналов", async () => {
  let from = await mark();
  await say({ text: "/add @telegram @nosuchchannel_zzq9" });
  const added = await until(newOwnerMessage(/Добавил: @telegram/u, from), "канал добавлен", 30_000);
  if (!/@nosuchchannel_zzq9: Канал @nosuchchannel_zzq9 не найден/u.test(added.visible)) throw new Error("нет сообщения про несуществующий канал");
  from = await mark();
  await say({ text: "/remove @telegram" });
  await until(newOwnerMessage(/Убрал @telegram/u, from), "канал убран");
});

let manualId = null;
await step("пересланный пост готовится вне очереди", async () => {
  const from = await mark();
  const text =
    "Исследователи из лаборатории Quanta Robotics показали открытую модель HelixMini для управления роботами-манипуляторами. " +
    "Модель весит 2 ГБ, запускается на одной видеокарте и обучена на 40 тысячах часов записей. Код и веса выложены на GitHub.";
  await say({
    caption: text,
    caption_entities: [{ type: "text_link", offset: text.indexOf("GitHub"), length: 6, url: "https://github.com/quanta-robotics/helixmini" }],
    photo: [{ file_id: "manual-photo-small", width: 90, height: 90 }, { file_id: "manual-photo", width: 1280, height: 720 }],
    forward_origin: { type: "channel", chat: { id: -1007001, type: "channel", username: "quanta_test_channel", title: "Quanta" }, message_id: 4242, date: Math.floor(Date.now() / 1000) - 300 },
  });
  const accepted = await until(newOwnerMessage(/Принял, готовлю пост №\d+/u, from), "ответ «Принял»");
  manualId = Number(/№(\d+)/u.exec(accepted.visible)[1]);
  const proposal = await until((current) => openProposals(current).find((candidate) => candidate.id === manualId), "предложение по пересланному посту", 240_000);
  const preview = previewOf(await state(), proposal.control);
  if (preview.media?.fileId !== "manual-photo") throw new Error("фото из пересланного поста не приложено");
  if (!/прислано вручную/u.test(proposal.control.visible)) throw new Error("нет отметки «прислано вручную»");
  if (!/HelixMini/u.test(preview.visible)) throw new Error("в тексте нет названия модели из источника");
  if (!(preview.caption ?? "").includes("github.com/quanta-robotics/helixmini")) throw new Error("ссылка на репозиторий потеряна");
  await press(`p:${manualId}`, proposal.control.message_id);
  await until((current) => toChannel(current).some((message) => /HelixMini/u.test(message.visible)), "публикация пересланного поста", 60_000);
  return `№${manualId}, ${preview.visible.length} знаков`;
});

await step("повторная пересылка уже опубликованного распознаётся", async () => {
  const from = await mark();
  const text =
    "Исследователи из лаборатории Quanta Robotics показали открытую модель HelixMini для управления роботами-манипуляторами. " +
    "Модель весит 2 ГБ, запускается на одной видеокарте и обучена на 40 тысячах часов записей. Код и веса выложены на GitHub.";
  await say({ text, forward_origin: { type: "channel", chat: { id: -1007002, type: "channel", username: "another_reposter" }, message_id: 9, date: Math.floor(Date.now() / 1000) - 60 } });
  await until(newOwnerMessage(/уже есть на канале/u, from), "ответ «уже есть на канале»");
});

await step("чужой пользователь получает отказ", async () => {
  await inject({ message: { chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false, first_name: "X" }, text: "/status" } });
  await until((current) => current.messages.some((message) => message.chat_id === "999" && /только со своим владельцем/u.test(message.visible)), "отказ постороннему");
});

const failed = results.filter((result) => !result.ok);
const final = await state();
console.log(
  `\nИтог для «${LABEL}»: ${results.length - failed.length} из ${results.length} шагов. В канал ушло постов: ${toChannel(final).length}, вызовов Bot API: ${final.calls.length}.`,
);
process.exit(failed.length === 0 ? 0 : 1);
