/** Gemini through the proxy: routing by header and path, and autopilot's view of generateContent bodies. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiModelFromUrl, upstreamFor } from "../proxy.js";
import { AutoClearer, viewOf } from "../autoclear.js";

test("Gemini requests go to Google; OpenAI's and Anthropic's look-alike paths do not", () => {
  const g = "https://generativelanguage.googleapis.com";
  assert.equal(upstreamFor("/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse", {}), g);
  assert.equal(upstreamFor("/v1/models/gemini-3-pro:generateContent", {}), g);
  assert.equal(upstreamFor("/v1/models", {}, { "x-goog-api-key": "k" }), g);
  assert.equal(upstreamFor("/upload/v1beta/files", {}), g);
  assert.equal(upstreamFor("/v1/models", { openaiUpstream: "https://o" }, { authorization: "Bearer x" }), "https://o");
  assert.equal(upstreamFor("/v1/models", { anthropicUpstream: "https://a" }, { "anthropic-version": "2023-06-01" }), "https://a");
  assert.equal(geminiModelFromUrl("/v1beta/models/gemini-3-pro:generateContent"), "gemini-3-pro");
});

function geminiBody(n: number) {
  const contents: any[] = [{ role: "user", parts: [{ text: "fix the build" }] }];
  for (let i = 0; i < n; i++) {
    contents.push({ role: "model", parts: [{ functionCall: { name: "read_file", args: { path: `f${i}` } } }] });
    contents.push({ role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: "x = 1\n".repeat(6000) } } }] });
  }
  return { contents };
}

test("viewOf reads functionResponse parts, ids scoped to the conversation when Gemini gives none", () => {
  const a = viewOf(geminiBody(3))!;
  assert.equal(a.format, "gemini");
  assert.equal(a.results.length, 3);
  assert.equal(a.toolName.get(a.results[0].id), "read_file");
  const other = geminiBody(3);
  other.contents[0].parts[0].text = "a different task";
  const b = viewOf(other)!;
  assert.notEqual(a.results[0].id, b.results[0].id, "the same position in another conversation is another id");
});

test("a cold Gemini request clears stale results and keeps the recent ones; the model comes from the hint", () => {
  const body = geminiBody(8);
  const r = new AutoClearer().apply(body, Date.now(), "gemini-3-pro");
  assert.ok(r.changed && r.cold && r.newlyCleared > 0);
  const responses = body.contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionResponse);
  assert.match(JSON.stringify(responses[0].functionResponse.response), /context-doctor|cleared/i);
  assert.equal(responses.at(-1).functionResponse.response.output, "x = 1\n".repeat(6000));
  assert.equal(responses[0].functionResponse.name, "read_file", "the part keeps its name, so the call stays paired");
});
