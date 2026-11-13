/**
 * The part of Claude Code's mods API the context-doctor mod uses, typed here
 * so the mod compiles with the rest of the package (the engine's own
 * declarations, `claude-code`, exist only inside a mod folder Claude Code
 * writes types into). Each name and shape below was read from the
 * declarations Claude Code 2.1.321 writes (`claude-code.d.ts`): `$.process.run`,
 * `$.session.{id,model,compact}`, `$.ui.{open,resolve,invalidate,toast}`,
 * `$.command.register`, `$.clock.{now,every}`, `$.env.get`, `$.plugin.root`,
 * and the events `session.start`, `session.measure`, `session.end`,
 * `command.run`, `ui.render`. A subset, structurally compatible: no runtime code.
 */
export {};
