/**
 * `compact-window off` with nothing set created a settings.json of `{}` and
 * claimed to have removed the setting; `compact-window 400k` on a machine
 * with no settings.json claimed "a .backup was kept" for a file that never
 * existed. Each now says what it actually did.
 */
export {};
