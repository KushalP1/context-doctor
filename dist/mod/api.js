/**
 * The part of Claude Code's mods API the context-doctor mod uses, typed here
 * so the mod compiles with the rest of the package (the engine's own
 * declarations, `claude-code`, exist only inside a mod folder Claude Code
 * writes types into). Each name and shape below was read from the
 * declarations Claude Code 2.1.321 writes (`claude-code.d.ts`): `$.process.run`,
 * `$.session.{id,model,compact}`, `$.ui.{open,resolve,invalidate,toast}`,
 * `$.command.register`, `$.clock.{now,every}`, `$.env.get`, `$.plugin.root`,
 * `$.model.fork` (from the GitHub copy of the declarations, 2026-11-15),
 * and the events `session.start`, `session.measure`, `session.end`,
 * `command.run`, `ui.render`; from 2.1.325's, for the usage pane,
 * `$.agent.list`, `$.session.usage`, the `Svg` element, a pane's `placement`
 * and `bodyColumns`, and `ui.close`; from 2.1.329's, `tool.describe` with
 * its `mcpServer` and an answer's `isDeferred`. A subset, structurally compatible: no
 * runtime code.
 */
export {};
