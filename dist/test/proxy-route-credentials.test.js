/**
 * A credential must only ever reach the provider that issued it. Unknown
 * paths used to go to OpenAI unless the request carried anthropic-version
 * or x-api-key, so a Bearer-only Anthropic request (Claude Code's OAuth
 * token on an /api/... call) would have carried that token to
 * api.openai.com. Anthropic credentials are recognisable (sk-ant-...), and
 * under autopilot, where Claude Code is the expected client, an unknown path
 * goes to Anthropic unless the request is plainly OpenAI's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { upstreamFor } from "../proxy.js";
const opts = { anthropicUpstream: "https://a", openaiUpstream: "https://o" };
test("autopilot: unknown paths go to Anthropic unless the request is plainly OpenAI's", () => {
    const ap = { ...opts, autopilot: true };
    assert.equal(upstreamFor("/api/oauth/profile", ap, { authorization: "Bearer sk-ant-oat01-abc" }), "https://a");
    assert.equal(upstreamFor("/api/hello", ap, {}), "https://a");
    assert.equal(upstreamFor("/v1/models", ap, { authorization: "Bearer opaque-token" }), "https://a");
    assert.equal(upstreamFor("/v1/models", ap, { authorization: "Bearer sk-proj-abc" }), "https://o", "an OpenAI key goes to OpenAI");
    assert.equal(upstreamFor("/v1/chat/completions", ap, {}), "https://o", "fixed OpenAI endpoints stay OpenAI's");
});
test("an Anthropic token never goes to OpenAI, autopilot or not", () => {
    assert.equal(upstreamFor("/v1/models", opts, { authorization: "Bearer sk-ant-api03-abc" }), "https://a");
    assert.equal(upstreamFor("/v1/models", opts, { authorization: "Bearer sk-ant-oat01-abc" }), "https://a");
    assert.equal(upstreamFor("/v1/models", opts, { "anthropic-beta": "oauth-2025-04-20", authorization: "Bearer x" }), "https://a");
    assert.equal(upstreamFor("/v1/models", opts, { authorization: "Bearer sk-abc" }), "https://o", "outside autopilot, other Bearer traffic still defaults to OpenAI");
});
