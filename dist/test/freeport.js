/** A port the OS reports free right now. Fixed or random ports in 8000-8899 can land on a running server (the autopilot proxy is on 8787). */
import { createServer } from "node:net";
export function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}
