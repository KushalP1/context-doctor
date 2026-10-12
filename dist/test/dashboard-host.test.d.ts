/**
 * The dashboard answers only requests addressed to loopback by name. A page
 * that rebinds its own hostname to 127.0.0.1 (DNS rebinding) reaches the port
 * but still sends its own Host, and must not get /api/data (session titles).
 */
export {};
