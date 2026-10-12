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
export {};
