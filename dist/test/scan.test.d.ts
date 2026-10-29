/**
 * The shared scan's cache (scan.ts): a grown transcript resumed where the
 * last read stopped gives the records a fresh read gives, for every
 * extractor, wherever the file was cut (mid-line too); rewritten, damaged
 * and foreign entries are never trusted; nothing is written with
 * CONTEXT_DOCTOR_NO_CACHE; the cache stays bounded; overlapping runs agree.
 */
export {};
