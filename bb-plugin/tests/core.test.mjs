// Unit tests for the pure parts: text handling, the channel page parser, the
// filter and draft formats, and the config.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { entitiesToHtml, entitiesToPlain } from "../src/bot.ts";
import {
  DEFAULT_CONFIG,
  REDACTED,
  applyConfigEdit,
  normalizeSources,
  redactConfig,
  resolveBackend,
  resolveConfig,
  serializeSources,
} from "../src/config.ts";
import {
  buildFilterPrompt,
  finalizeDraft,
  findCandidates,
  parseDraftReply,
  parseFilterReply,
  prefilter,
} from "../src/pipeline.ts";
import {
  contentTokens,
  extractJson,
  fingerprint,
  linkKeys,
  overlap,
  sanitizeTelegramHtml,
  visibleLength,
} from "../src/text.ts";
import { TmeError, channelTarget, parseChannelHandle, parseChannelPage } from "../src/tme.ts";
import { configWarnings, deepMerge } from "../src/config.ts";
import { EXAMPLE_OVERRIDES, PLACEHOLDER_PATTERN } from "../standalone-src/example-config.ts";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("fingerprint ignores links, case and punctuation", () => {
  const a = "OpenAI выпустила GPT-6!  Подробнее: https://openai.com/blog/gpt-6";
  const b = "openai выпустила gpt 6 — подробнее https://t.me/some/1";
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint("Google выпустила Gemini"));
});

test("content tokens fold inflections and feed overlap", () => {
  const first = contentTokens("Компания Google представила новую модель Gemini 4 Neon для разработчиков");
  const second = contentTokens("Google представил модели Gemini 4 Neon: что нового для разработчика");
  assert.ok(overlap(first, second) > 0.6, `overlap ${overlap(first, second)}`);
  assert.ok(overlap(first, contentTokens("Биткоин упал ниже шестидесяти тысяч долларов на фоне распродажи")) < 0.2);
});

test("link keys keep external pages and drop Telegram and bare domains", () => {
  assert.deepEqual(
    linkKeys(["https://github.com/Example-Sec/SafeScan/", "https://t.me/example_channel/10", "https://www.example.com/", "not a url"]),
    ["github.com/example-sec/safescan"],
  );
});

test("sanitizer keeps the Telegram subset and neutralizes the rest", () => {
  assert.equal(
    sanitizeTelegramHtml('<b>Жирный</b> и <a href="https://example.com/a?b=1&c=2">ссылка</a><script>alert(1)</script>'),
    '<b>Жирный</b> и <a href="https://example.com/a?b=1&amp;c=2">ссылка</a>alert(1)',
  );
  assert.equal(sanitizeTelegramHtml('<a href="javascript:alert(1)">x</a>'), "x");
  assert.equal(sanitizeTelegramHtml("<b>не закрыт"), "<b>не закрыт</b>");
  assert.equal(sanitizeTelegramHtml("2 < 3 & 5 > 4"), "2 &lt; 3 &amp; 5 &gt; 4");
  assert.equal(sanitizeTelegramHtml("<strong>a</strong><em>b</em><p>c</p>"), "<b>a</b><i>b</i>c");
  assert.equal(sanitizeTelegramHtml("строка<br>ещё"), "строка\nещё");
});

test("visible length counts what the reader sees", () => {
  assert.equal(visibleLength('<b>abc</b> &amp; <a href="https://x.y/z">d</a>'), 7);
});

test("extractJson reads arrays and objects out of wrapped replies", () => {
  assert.deepEqual(extractJson('Вот результат: [{"id": 1}, {"id": 2}] Готово.'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(extractJson('```json\n{"text": "привет"}\n```'), { text: "привет" });
  assert.deepEqual(extractJson('Ответ: [{"id": 1}]'), [{ id: 1 }]);
  assert.throws(() => extractJson("никакого JSON тут нет"), /не в формате JSON/u);
});

test("extractJson repairs string values that lost their opening quote", () => {
  const broken = [
    "[",
    "  {",
    '    "id": 63,',
    '    "verdict": "skip",',
    '    "score": null,',
    '    "title": "В разработке продолжение «Один дома»",',
    '    "summary": Маколей Калкин вновь сыграет Кевина в продолжении фильма.",',
    '    "reason": Киноновость не связана с ИИ."',
    "  }",
    "]",
  ].join("\n");
  assert.deepEqual(extractJson(broken), [
    {
      id: 63,
      verdict: "skip",
      score: null,
      title: "В разработке продолжение «Один дома»",
      summary: "Маколей Калкин вновь сыграет Кевина в продолжении фильма.",
      reason: "Киноновость не связана с ИИ.",
    },
  ]);
  assert.equal(parseFilterReply(broken)[0].summary, "Маколей Калкин вновь сыграет Кевина в продолжении фильма.");
});

test("channel page parser reads posts, media and links", () => {
  const page = parseChannelPage(fixture("channel-latest.html"), "example_ai_news");
  assert.equal(page.title, "Example AI News");
  assert.equal(page.description, "Новости ИИ без воды.\nПример описания канала для тестов.");
  assert.equal(page.posts.length, 14, "the service message is skipped");
  const ids = page.posts.map((post) => post.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "posts are ordered by id");
  const album = page.posts.find((post) => post.id === 4083);
  assert.equal(album.media.filter((item) => item.kind === "photo" && item.url).length, 3);
  assert.ok(album.links.includes("https://github.com/example-sec/safescan"));
  assert.match(album.text, /^Инструмент SafeScan для поиска уязвимостей, как сообщается \(https:\/\/news\.example\.org\/safescan\)/u, "a link whose label differs keeps its address");
  assert.equal(album.views, 80);
  const bigVideo = page.posts.find((post) => post.id === 4086);
  assert.deepEqual(bigVideo.media.map((item) => [item.kind, item.url]), [["video", null]]);
  assert.ok(page.posts.every((post) => !Number.isNaN(new Date(post.date).getTime())));
  const reply = page.posts.find((post) => post.id === 4075);
  assert.match(reply.text, /^Ответ на прошлый пост/u, "the quoted reply is not taken as the post text");
  const forwarded = page.posts.find((post) => post.id === 4073);
  assert.equal(forwarded.forwardedFrom, "Other Channel Example");
  const digest = page.posts.find((post) => post.id === 4072);
  assert.deepEqual(digest.links, [], "hashtag search links are not links");
  assert.equal(page.posts.find((post) => post.id === 4076).media[0].kind, "other");
  assert.equal(page.posts.find((post) => post.id === 4080).text, "", "a post with only a video has no text");
  assert.equal(page.posts.find((post) => post.id === 4071).views, 1200);
});

test("a missing or private channel is reported as not found", () => {
  assert.throws(
    () => parseChannelPage(fixture("channel-missing.html"), "nochannel"),
    (error) => error instanceof TmeError && error.code === "not_found",
  );
});

test("channel handles are parsed from names and links", () => {
  assert.equal(parseChannelHandle("@Example_Channel"), "example_channel");
  assert.equal(parseChannelHandle("https://t.me/s/some_news_feed?before=10"), "some_news_feed");
  assert.equal(parseChannelHandle("t.me/demo_digest/123"), "demo_digest");
  assert.equal(parseChannelHandle("https://t.me/+AbCdEf123"), null);
  assert.equal(parseChannelHandle("https://t.me/joinchat/AbCdEf"), null);
  assert.equal(parseChannelHandle("просто текст"), null);
});

test("filter reply parser accepts null fields, quoted numbers and odd case", () => {
  const reply = JSON.stringify([
    { id: 56, verdict: "skip", duplicate_of: null, score: null, title: "Поезд", summary: "…", reason: "не по теме" },
    { id: "30", verdict: "Duplicate", duplicate_of: "S118", score: null, title: null, summary: null, reason: null },
    { id: 7, verdict: "new", duplicate_of: null, score: "82", title: "Новая модель", summary: "Суть", reason: "важно" },
    { id: 8, verdict: "maybe" },
  ]);
  const verdicts = parseFilterReply(reply);
  assert.equal(verdicts.length, 3);
  assert.deepEqual(
    verdicts.map((verdict) => [verdict.id, verdict.verdict, verdict.duplicate_of, verdict.score]),
    [
      [56, "skip", null, null],
      [30, "duplicate", "S118", null],
      [7, "new", null, 82],
    ],
  );
  assert.equal(verdicts[1].title, undefined);
  assert.equal(parseFilterReply('{"results": [{"id": 1, "verdict": "new", "score": 70}]}').length, 1);
});

test("draft reply parser and finalizer keep exactly one signature", () => {
  assert.deepEqual(parseDraftReply('{"text": "Привет", "comment": null}'), { text: "Привет", comment: "" });
  assert.throws(() => parseDraftReply('{"post": "нет поля text"}'));
  assert.equal(finalizeDraft("Текст поста\n\n@MyChannel", "@MyChannel"), "Текст поста\n\n@MyChannel");
  assert.equal(finalizeDraft("Текст <b>поста</b>", "@MyChannel"), "Текст <b>поста</b>\n\n@MyChannel");
  assert.equal(finalizeDraft("Без подписи", ""), "Без подписи");
});

const post = (patch = {}) => ({
  id: 1,
  source_id: 1,
  source_handle: "chan",
  msg_id: 10,
  url: "https://t.me/chan/10",
  posted_at: new Date().toISOString(),
  text: "Компания представила новую открытую модель для генерации кода, которая работает локально.",
  media_json: "[]",
  links_json: "[]",
  fwd_from: null,
  fingerprint: "x",
  story_id: null,
  state: "new",
  skip_reason: null,
  created_at: new Date().toISOString(),
  ...patch,
});

test("prefilter drops stale, short, ad and self-forwarded posts", () => {
  const now = Date.now();
  assert.equal(prefilter(post(), DEFAULT_CONFIG, now), null);
  assert.equal(prefilter(post({ posted_at: new Date(now - 72 * 3_600_000).toISOString() }), DEFAULT_CONFIG, now), "устарел");
  assert.equal(prefilter(post({ text: "Коротко" }), DEFAULT_CONFIG, now), "слишком мало текста");
  assert.equal(prefilter(post({ text: "Смотрите", media_json: '[{"kind":"video","url":"https://x/v.mp4"}]' }), DEFAULT_CONFIG, now), null, "a short caption under a video is kept");
  assert.equal(prefilter(post({ text: "" }), DEFAULT_CONFIG, now), "нет текста");
  assert.equal(prefilter(post({ text: `${post().text} #реклама` }), resolveConfig({ editorial: { skipAds: false } }), now), null, "ads are kept when the owner turns that off");
  assert.equal(prefilter(post({ text: `${post().text} #реклама` }), DEFAULT_CONFIG, now), "реклама");
  const own = resolveConfig({ telegram: { channel: "@mychannel" } });
  assert.equal(prefilter(post({ fwd_from: "MyChannel news" }), own, now), "репост с нашего канала");
});

const story = (id, status, text, links = []) => ({
  id,
  status,
  title: text.slice(0, 40),
  summary: text,
  tokens: contentTokens(text).join(" "),
  link_keys: linkKeys(links).join(" "),
});

test("candidate search finds the same news by words or by link", () => {
  const stories = [
    story(1, "published", "Google представила модель Gemini 4 Neon, она обходит Opus 5.5 и GPT-6.2 Sol в написании кода"),
    story(2, "rejected", "Биткоин упал ниже шестидесяти тысяч долларов на фоне распродажи акций"),
    story(3, "own", "Инструмент SafeScan автоматизирует поиск уязвимостей", ["https://github.com/Example-Sec/SafeScan"]),
  ];
  const sameWords = findCandidates(
    contentTokens("Вышла Gemini 4 Neon от Google: модель обгоняет Opus 5.5 и GPT-6.2 Sol в коде"),
    [],
    stories,
  );
  assert.equal(sameWords[0].story.id, 1);
  const sameLink = findCandidates(contentTokens("Совсем другие слова про хакерский софт"), linkKeys(["https://github.com/example-sec/safescan"]), stories);
  assert.equal(sameLink[0].story.id, 3);
  assert.equal(findCandidates(contentTokens("Новый робот-пылесос научился мыть окна и лестницы"), [], stories).length, 0);
});

test("filter prompt in select mode carries the channel profile, posts and memory", () => {
  const selectMode = resolveConfig({ editorial: { proposeAll: false } });
  const prompt = buildFilterPrompt(
    selectMode,
    [{ post: post({ id: 42 }), candidates: [{ story: story(7, "published", "Похожая новость про модель"), similarity: 0.5 }] }],
    { accepted: ["Принятая новость"], rejected: ["Отклонённая новость (не по теме)"] },
  );
  assert.match(prompt, /<post id="42" source="@chan"/u);
  assert.match(prompt, /\[S7\] \(уже опубликовано на канале\)/u);
  assert.match(prompt, /\+ принял: Принятая новость/u);
  assert.match(prompt, /- отклонил: Отклонённая новость \(не по теме\)/u);
  assert.ok(prompt.includes(DEFAULT_CONFIG.editorial.channelProfile));
  assert.match(prompt, /"skip"/u);
  assert.match(prompt, /"score"/u);
});

test("filter prompt in propose-everything mode only looks for repeats", () => {
  const memory = [story(7, "published", "Anthropic выпустила новые модели Claude"), story(9, "rejected", "Биткоин упал")];
  const prompt = buildFilterPrompt(
    DEFAULT_CONFIG,
    [{ post: post({ id: 42 }), candidates: [] }],
    { accepted: ["Принятая новость"], rejected: ["Отклонённая новость"] },
    memory,
  );
  assert.equal(DEFAULT_CONFIG.editorial.proposeAll, true, "proposing everything is the default");
  assert.match(prompt, /только найти повторы/u);
  assert.match(prompt, /"verdict": "duplicate" или "new"/u);
  assert.doesNotMatch(prompt, /"skip"|"score"/u, "no relevance judging");
  assert.doesNotMatch(prompt, /принял:|отклонил:/u, "the owner's past decisions are not used as taste");
  assert.ok(!prompt.includes(DEFAULT_CONFIG.editorial.channelProfile));
  assert.match(prompt, /\[S7\] \(уже опубликовано на канале\) Anthropic выпустила новые модели Claude/u, "every known story is listed by title");
  assert.match(prompt, /Другие подробности о том же поводе/u);
});

test("config: partial files load over defaults and bad values are reported", () => {
  const config = resolveConfig({ telegram: { channel: "@mychannel" }, schedule: { pollMinutes: 10 } });
  assert.equal(config.telegram.channel, "@mychannel");
  assert.equal(config.schedule.pollMinutes, 10);
  assert.equal(config.llm.filterModel, DEFAULT_CONFIG.llm.filterModel);
  assert.throws(() => resolveConfig({ schedule: { pollMinutes: "часто" } }), /schedule\.pollMinutes/u);
  assert.throws(() => resolveConfig({ unknownSection: {} }), /Ошибка в настройках/u);
});

test("config: secrets are masked on export and survive a round trip", () => {
  const current = resolveConfig({ telegram: { botToken: "123:ABC" }, llm: { apiKey: "sk-secret" } });
  const shown = redactConfig(current);
  assert.equal(shown.telegram.botToken, REDACTED);
  assert.equal(shown.llm.apiKey, REDACTED);
  assert.equal(shown.llm.bbToken, "");
  const edited = structuredClone(shown);
  edited.editorial.minScore = 75;
  const next = applyConfigEdit(current, edited);
  assert.equal(next.telegram.botToken, "123:ABC");
  assert.equal(next.llm.apiKey, "sk-secret");
  assert.equal(next.editorial.minScore, 75);
  assert.equal(applyConfigEdit(current, { telegram: { botToken: "999:NEW" } }).telegram.botToken, "999:NEW");
});

test("config: sources list is normalized and written back compactly", () => {
  const config = resolveConfig({
    sources: ["@Alpha_News", "https://t.me/beta_digest", { handle: "@gamma_feed", enabled: false }, "alpha_news", "мусор"],
  });
  const entries = normalizeSources(config, parseChannelHandle);
  assert.deepEqual(entries, [
    { handle: "alpha_news", enabled: true },
    { handle: "beta_digest", enabled: true },
    { handle: "gamma_feed", enabled: false },
  ]);
  assert.deepEqual(serializeSources(entries), ["@alpha_news", "@beta_digest", { handle: "@gamma_feed", enabled: false }]);
});

test("config: backend resolution depends on where the service runs", () => {
  assert.equal(resolveBackend(DEFAULT_CONFIG, "bb"), "bb-threads");
  assert.equal(resolveBackend(DEFAULT_CONFIG, "standalone"), "openai");
  const remote = resolveConfig({ llm: { bbUrl: "https://example.getbb.app" } });
  assert.equal(resolveBackend(remote, "standalone"), "bb-remote");
  assert.equal(resolveBackend(resolveConfig({ llm: { backend: "bb-threads" } }), "standalone"), "bb-remote");
});

test("message entities become Telegram HTML and plain text with visible links", () => {
  const text = "Жирный и ссылка тут";
  const entities = [
    { type: "bold", offset: 0, length: 6 },
    { type: "text_link", offset: 9, length: 6, url: "https://example.com/?a=1&b=2" },
  ];
  assert.equal(
    entitiesToHtml(text, entities),
    '<b>Жирный</b> и <a href="https://example.com/?a=1&amp;b=2">ссылка</a> тут',
  );
  assert.equal(entitiesToHtml("a < b", []), "a &lt; b");
  const plain = entitiesToPlain(text, entities);
  assert.equal(plain.text, "Жирный и ссылка (https://example.com/?a=1&b=2) тут");
  assert.deepEqual(plain.links, ["https://example.com/?a=1&b=2"]);
  // Overlapping entities still produce well-formed markup.
  const overlapping = entitiesToHtml("abcdef", [
    { type: "bold", offset: 0, length: 4 },
    { type: "italic", offset: 2, length: 4 },
  ]);
  assert.equal(overlapping, "<b>ab</b><b><i>cd</i></b><i>ef</i>");
});

test("channel targets accept a handle, a link or a numeric id", () => {
  assert.equal(channelTarget("@My_Channel"), "@my_channel");
  assert.equal(channelTarget("https://t.me/my_channel"), "@my_channel");
  assert.equal(channelTarget("my_channel"), "@my_channel");
  assert.equal(channelTarget("-1001234567890"), "-1001234567890");
  assert.equal(channelTarget("@my channel"), null);
  assert.equal(channelTarget(""), null);
});

test("config warnings catch placeholders and values that cannot work", () => {
  const helpers = { isPlaceholder: (value) => PLACEHOLDER_PATTERN.test(value.trim()), channelTarget };
  const example = resolveConfig(deepMerge(DEFAULT_CONFIG, EXAMPLE_OVERRIDES));
  const warnings = configWarnings(example, "standalone", helpers).join("\n");
  for (const field of ["telegram.botToken", "telegram.channel", "sources", "llm.apiKey", "llm.filterModel", "llm.writerModel", "editorial.footer"]) {
    assert.match(warnings, new RegExp(field.replace(".", "\\.")), `${field} is reported`);
  }
  const filled = resolveConfig({
    telegram: { botToken: "123456:fake_token_used_only_in_tests", channel: "@my_channel" },
    sources: ["@some_news_feed"],
    llm: { backend: "openai", apiBaseUrl: "https://example.org/v1", apiKey: "key", filterModel: "small", writerModel: "large" },
  });
  assert.deepEqual(configWarnings(filled, "standalone", helpers), []);
  const badChannel = resolveConfig({ ...filled, telegram: { ...filled.telegram, channel: "@my channel" } });
  assert.match(configWarnings(badChannel, "standalone", helpers).join(" "), /telegram\.channel .* указан неверно/u);
  assert.deepEqual(configWarnings(filled, "bb", helpers), [], "inside bb the openai checks apply only when chosen");
});
