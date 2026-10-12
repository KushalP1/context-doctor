/**
 * withContextDoctor and thinking blocks. On current Claude models a thinking
 * block's signature binds the history before it, and enforced accounts get
 * a 400 for an edited one, on every retry of the same body. As the proxy
 * does, the wrapper sends the caller's own request once instead and answers
 * with that, remembers the account so its conversations are not edited where
 * a thinking block follows, and forgets the refused request's clearings.
 * The fake client enforces like the API: it refuses a request whose messages
 * differ from the caller's before a thinking block. No SDK, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoClearer } from "../autoclear.js";
import { contextDoctorStats, withContextDoctor } from "../wrap.js";
const HOUR = 3_600_000;
const REFUSAL = { type: "error", error: { type: "invalid_request_error", message: "messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." } };
/** `rounds` large Read results, each assistant turn opening with a thinking block. */
function conversation(task, rounds) {
    const messages = [{ role: "user", content: task }];
    for (let i = 0; i < rounds; i++) {
        const id = `toolu_${task.replace(/\W/g, "")}_${i}`;
        messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: `sig-${task}-${i}` }, { type: "tool_use", id, name: "Read", input: { file_path: `/f${i}` } }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `export const x${i} = compute(input);\n`.repeat(1500) }] });
    }
    return { model: "claude-opus-5-5", max_tokens: 1024, messages };
}
/** An SDK-shaped 400, as @anthropic-ai/sdk throws it (BadRequestError: status, message, parsed body). */
function badRequest(body) {
    return Object.assign(new Error(`400 ${JSON.stringify(body)}`), { status: 400, error: body });
}
/** The answer an SDK method gives: a promise with the SDK's extra methods (APIPromise's withResponse). */
function apiPromise(settle) {
    const p = new Promise((resolve, reject) => { try {
        resolve(settle());
    }
    catch (e) {
        reject(e);
    } });
    return Object.assign(p, { withResponse: () => p.then((data) => ({ data, response: { status: 200 } })) });
}
/** A fake Anthropic client for one enforced account. `pristine` is what the caller sent. */
function enforcedClient(opts = {}) {
    let pristine = [];
    const calls = [];
    const answer = (params) => {
        calls.push(params);
        if (opts.otherError)
            throw opts.otherError;
        let first = 0;
        while (first < pristine.length && JSON.stringify(params.messages[first]) === JSON.stringify(pristine[first]))
            first++;
        const thinkingLater = params.messages.slice(first).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"));
        if (first < pristine.length && thinkingLater)
            throw badRequest(REFUSAL);
        return { id: `msg_${calls.length}`, content: [{ type: "text", text: "ok" }] };
    };
    const client = {
        apiKey: "sk-ant-test-enforced",
        messages: {
            create: (params) => apiPromise(() => answer(params)),
            // A stream() that fails before any event, synchronously.
            stream: (params) => ({ stream: answer(params) }),
        },
        beta: { messages: { create: (params) => apiPromise(() => answer(params)) } },
    };
    return { client, calls, send: (body) => { pristine = body.messages; calls.length = 0; return body; } };
}
/** Last seen two hours ago, so the next request finds the cache cold and autopilot clears. */
function idle(clearer, body) {
    clearer.apply(structuredClone(body), Date.now() - 2 * HOUR);
}
test("a refused edit is resent once as the caller wrote it; the caller gets that answer", async () => {
    const { client, calls, send } = enforcedClient();
    const clearer = new AutoClearer({ unseenIsWarm: true });
    const wrapped = withContextDoctor(client, { clearer });
    const body = send(conversation("task one", 12));
    idle(clearer, body);
    const r = await wrapped.messages.create(body);
    assert.equal(calls.length, 2);
    assert.notDeepEqual(calls[0].messages, body.messages, "autopilot cleared stale reads (cold)");
    assert.equal(calls[1], body, "the resend is the caller's own params, by reference");
    assert.equal(r.id, "msg_2");
    assert.deepEqual(contextDoctorStats(wrapped), { requests: 1, changed: 0, tokensRemoved: 0 }, "the refused edit is not counted as a saving");
    // The account is remembered: the next cold request is not edited where a thinking block follows.
    const next = send(conversation("task one", 13));
    idle(clearer, next);
    await wrapped.messages.create(next);
    assert.equal(calls.length, 1, "no refused round trip");
    assert.equal(calls[0], next, "sent as written");
});
test("the SDK's promise keeps its shape: withResponse falls back to the same single resend", async () => {
    const { client, calls, send } = enforcedClient();
    const clearer = new AutoClearer({ unseenIsWarm: true });
    const wrapped = withContextDoctor(client, { clearer });
    const body = send(conversation("task two", 12));
    idle(clearer, body);
    const p = wrapped.beta.messages.create(body);
    const [{ data, response }, awaited] = await Promise.all([p.withResponse(), p]);
    assert.equal(calls.length, 2, "one resend for both");
    assert.equal(response.status, 200);
    assert.equal(data.id, "msg_2");
    assert.equal(awaited.id, "msg_2");
});
test("stream(): a refusal thrown before any event is retried the same way", () => {
    const { client, calls, send } = enforcedClient();
    const clearer = new AutoClearer({ unseenIsWarm: true });
    const wrapped = withContextDoctor(client, { clearer });
    const body = send(conversation("task three", 12));
    idle(clearer, body);
    const s = wrapped.messages.stream(body);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], body);
    assert.equal(s.stream.id, "msg_2");
    assert.equal(contextDoctorStats(wrapped).changed, 0);
});
test("any other 400 reaches the caller unchanged, with no resend", async () => {
    const other = badRequest({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } });
    const { client, calls, send } = enforcedClient({ otherError: other });
    const clearer = new AutoClearer({ unseenIsWarm: true });
    const wrapped = withContextDoctor(client, { clearer });
    const body = send(conversation("task four", 12));
    idle(clearer, body);
    await assert.rejects(wrapped.messages.create(body), (e) => e === other);
    assert.equal(calls.length, 1);
    assert.equal(contextDoctorStats(wrapped).changed, 1, "the edit stands: it was not what the API refused");
});
