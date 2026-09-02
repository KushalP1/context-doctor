/**
 * Transcript parsing is streamed, not slurped. These tests pin the two things
 * that streaming can get wrong and a whole-file read cannot: chunk boundaries
 * landing mid-line and mid-UTF-8-sequence.
 */
export {};
