/**
 * A client that walks away mid-stream must not take the proxy down with it.
 *
 * Ctrl-C on a streaming request, a closed laptop lid, an SDK timeout — all
 * destroy the client socket while the proxy is still piping upstream bytes
 * into it. If that path throws, the user's proxy dies and every subsequent
 * request in every app fails.
 */
export {};
