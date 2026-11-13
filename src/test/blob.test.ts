/**
 * Inline base64 of any size is found, not a crash. The matcher was one
 * regular expression, /[A-Za-z0-9+/]{500,}/, which threw "Maximum call
 * stack size exceeded" on a run past about 5.5 million characters: a 4 MB
 * screenshot or PDF pasted as base64 ended analyze, profile_context and
 * optimize at the very blob they exist to find.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BASE64_PLACEHOLDER, hasBase64Blob, stripBase64Blobs } from "../blob.js";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { optimizeConversation } from "../optimize.js";

const big = randomBytes(6_000_000).toString("base64"); // 8 million characters

test("an 8-million-character base64 blob is found and stripped, not a stack overflow", () => {
  const text = `here is the screenshot: ${big} what do you see?`;
  assert.equal(hasBase64Blob(text), true);
  assert.equal(stripBase64Blobs(text), `here is the screenshot: ${BASE64_PLACEHOLDER} what do you see?`);
  const conversation = JSON.stringify({ messages: [{ role: "user", content: text }, { role: "assistant", content: "A chart." }] });
  const profile = profileConversation(parseConversation(conversation));
  assert.ok(profile.findings.some((f) => f.id === "base64_blob"), JSON.stringify(profile.findings.map((f) => f.id)));
  const slim = optimizeConversation(conversation, { strategies: ["strip-base64"] });
  assert.ok(slim.tokensAfter < slim.tokensBefore / 100);
});

test("as the expression matched: a data: URI header goes with its payload, padding is kept to two, lookalikes stay", () => {
  const payload = randomBytes(600).toString("base64").replace(/=+$/, "");
  assert.equal(stripBase64Blobs(`a data:image/png;base64,${payload}== b`), `a ${BASE64_PLACEHOLDER} b`);
  assert.equal(stripBase64Blobs(`a ${payload}=== b`), `a ${BASE64_PLACEHOLDER}= b`);
  // A run that ends in "data" is one candidate; the header after it cannot borrow those characters.
  assert.equal(stripBase64Blobs(`${payload}data:image/png;base64,${payload}`), `${BASE64_PLACEHOLDER}:image/png;base64,${BASE64_PLACEHOLDER}`);
  const lookalike = "a".repeat(5000);
  assert.equal(stripBase64Blobs(`x ${lookalike} y`), `x ${lookalike} y`);
  assert.equal(hasBase64Blob(`x ${lookalike} y ${payload.slice(0, 499)}`), false);
});
