/**
 * analyze, optimize and diff on a file that is not a conversation: broken
 * JSON, JSON without messages, an array without roles. analyze used to
 * profile it as a handful of tokens and say the context was in good shape;
 * diff compared 0 tokens with 0. Each must fail with the reason.
 */
export {};
