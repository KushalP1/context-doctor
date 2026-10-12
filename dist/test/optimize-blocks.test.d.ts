/**
 * The optimizer edits one block at a time.
 *
 * Until 0.31 a strategy rewrote a whole message as one string and put it back
 * into the first block: a message holding two parallel tool results and a
 * note from the user came out with both outputs under the first call's id,
 * "[removed]" under the second and the note gone. That ran by default in the
 * optimizing proxy, on live requests.
 */
export {};
