// The two model backends the standalone script uses, each against a local
// server that checks what a real one would: path, auth and body shape.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createOpenAiLlm } from "../src/llm/openai.ts";
import { createRemoteLlm } from "../src/llm/remote.ts";

let server;
let base;
const seen = [];
const jobs = new Map();

before(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const url = new URL(request.url, "http://localhost");
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === "/v1/chat/completions") {
      if (request.headers.authorization !== "Bearer sk-good") return send(401, { error: { message: "Incorrect API key" } });
      if (body.model === "empty-model") return send(200, { choices: [{ message: { content: "" } }] });
      return send(200, { choices: [{ message: { role: "assistant", content: `ответ на: ${body.messages[0].content}` } }] });
    }
    if (url.pathname.startsWith("/api/v1/plugins/newsdesk/http/")) {
      if (request.headers["x-bb-plugin-token"] !== "plugin-token") return send(401, { error: "unauthorized" });
      if (url.pathname.endsWith("/llm")) {
        const jobId = `job-${jobs.size + 1}`;
        jobs.set(jobId, { polls: 0, body });
        return send(202, { jobId });
      }
      if (url.pathname.endsWith("/llm-result")) {
        const job = jobs.get(url.searchParams.get("job"));
        if (job === undefined) return send(200, { status: "unknown" });
        job.polls += 1;
        if (job.body.prompt === "сломайся") return send(200, { status: "error", error: "Модель не ответила" });
        return send(200, job.polls < 2 ? { status: "running" } : { status: "done", text: `готово: ${job.body.prompt}` });
      }
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const request = (patch = {}) => ({ task: "отбор", model: "gpt-6.1-terra", reasoning: "low", prompt: "вопрос", signal: new AbortController().signal, ...patch });

test("OpenAI-compatible backend sends one user message and returns the reply text", async () => {
  const llm = createOpenAiLlm({ apiBaseUrl: `${base}/v1/`, apiKey: "sk-good", fetch });
  assert.equal(await llm.run(request()), "ответ на: вопрос");
  const call = seen.at(-1);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/v1/chat/completions");
  assert.deepEqual(call.body, { model: "gpt-6.1-terra", messages: [{ role: "user", content: "вопрос" }] });
});

test("OpenAI-compatible backend reports a bad key, an empty reply and missing settings", async () => {
  await assert.rejects(createOpenAiLlm({ apiBaseUrl: `${base}/v1`, apiKey: "sk-bad", fetch }).run(request()), /кодом 401.*Incorrect API key/u);
  await assert.rejects(createOpenAiLlm({ apiBaseUrl: `${base}/v1`, apiKey: "sk-good", fetch }).run(request({ model: "empty-model" })), /пустой ответ/u);
  await assert.rejects(createOpenAiLlm({ apiBaseUrl: "", apiKey: "", fetch }).run(request()), /llm\.apiBaseUrl и llm\.apiKey/u);
});

test("bb backend starts a job on the plugin and polls it to the result", async () => {
  const llm = createRemoteLlm({ bbUrl: `${base}/`, token: "plugin-token", fetch });
  assert.equal(await llm.run(request({ prompt: "напиши пост" })), "готово: напиши пост");
  const start = seen.find((call) => call.path.endsWith("/llm") && call.body?.prompt === "напиши пост");
  assert.deepEqual(start.body, { task: "отбор", model: "gpt-6.1-terra", reasoning: "low", prompt: "напиши пост" });
  assert.equal(start.headers["x-bb-plugin-token"], "plugin-token");
});

test("bb backend reports a model failure and a rejected token", async () => {
  await assert.rejects(createRemoteLlm({ bbUrl: base, token: "plugin-token", fetch }).run(request({ prompt: "сломайся" })), /Модель не ответила/u);
  await assert.rejects(createRemoteLlm({ bbUrl: base, token: "wrong", fetch }).run(request()), /отклонил токен плагина/u);
});
