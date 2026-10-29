/**
 * Install then uninstall gives every config back byte for byte.
 *
 * Install used to parse each config and write it back with JSON.stringify:
 * a minified file came back indented, an inline array came back one item a
 * line, CRLF became LF, "é" became "é" and 30.0 became 30, so 9 of 11
 * configs differed after a round trip (QA, 0.39.0). Edits are now made to
 * the text, key by key and list item by list item (settingsedit.ts), and
 * uninstall takes out exactly what install put in. The skills folders
 * install had to create go too, once empty.
 */
export {};
