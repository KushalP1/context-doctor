/** session: ChatGPT data-export (conversations.json) parsing. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "../session.js";

function node(id: string, role: string, text: string, t: number): [string, unknown] {
  return [id, { id, message: { author: { role }, content: { content_type: "text", parts: [text] }, create_time: t } }];
}

const older = {
  title: "Older chat",
  update_time: 100,
  default_model_slug: "gpt-4o",
  mapping: Object.fromEntries([node("a", "user", "old question", 1)]),
};
const newer = {
  title: "Trip planning",
  update_time: 200,
  default_model_slug: "gpt-5",
  mapping: Object.fromEntries([
    node("r", "system", "You are helpful.", 1),
    node("x", "user", "Plan me a trip to Japan with a detailed itinerary please.", 2),
    node("y", "assistant", "Day 1: Tokyo. Day 2: Kyoto. Day 3: Osaka with food tour.", 3),
    ["tool-node", { id: "tool-node", message: { author: { role: "tool" }, content: { content_type: "text", parts: ["ignored"] }, create_time: 4 } }],
  ]),
};

test("parses a ChatGPT export: newest conversation, ordered messages, model detected", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-gpt-"));
  const file = join(dir, "conversations.json");
  writeFileSync(file, JSON.stringify([older, newer]));

  const parsed = parseSessionFile(file);
  assert.equal(parsed.title, "Trip planning");
  assert.equal(parsed.model, "gpt-5");
  assert.equal(parsed.messageCount, 3); // tool node excluded
  const conv = JSON.parse(parsed.conversationJson);
  assert.equal(conv.messages[0].role, "system");
  assert.equal(conv.messages[1].content.includes("Japan"), true);
});

test("JSONL transcripts still parse (no regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-jsonl-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(parseSessionFile(file).messageCount, 1);
});

test("turns containing images are not dropped from a ChatGPT export", async () => {
  const { parseSessionFile } = await import("../session.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-gptmm-"));
  const path = join(dir, "conversations.json");
  // ChatGPT exports any turn with an attachment as multimodal_text, with the
  // asset as an object among the string parts.
  writeFileSync(
    path,
    JSON.stringify([
      {
        title: "With a screenshot",
        default_model_slug: "gpt-4o",
        mapping: {
          a: {
            id: "a",
            message: {
              author: { role: "user" },
              create_time: 1,
              content: { content_type: "multimodal_text", parts: [{ asset_pointer: "file-service://x" }, "what is wrong here?"] },
            },
          },
          b: {
            id: "b",
            message: {
              author: { role: "assistant" },
              create_time: 2,
              content: { content_type: "text", parts: ["The margin is off."] },
            },
          },
          c: {
            id: "c",
            message: {
              author: { role: "user" },
              create_time: 3,
              // An image with no text at all still occupies context.
              content: { content_type: "multimodal_text", parts: [{ asset_pointer: "file-service://y" }] },
            },
          },
        },
      },
    ])
  );

  const parsed = parseSessionFile(path);
  assert.equal(parsed.messageCount, 3, "an image-only turn still counts");
  const conversation = JSON.parse(parsed.conversationJson) as { messages: Array<{ content: string }> };
  assert.match(conversation.messages[0].content, /what is wrong here\?/, "text alongside an image survives");
  assert.match(conversation.messages[0].content, /\[image\]/, "and the attachment is marked as an image");
  assert.ok(conversation.messages[2].content.length > 0, "an image-only turn is not empty");
});
