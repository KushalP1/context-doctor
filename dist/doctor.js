/**
 * `context-doctor doctor` — self-check for a local installation.
 *
 * Verifies every integration point end to end and prints one ✓/✗/– line per
 * check, so "it doesn't work" becomes a single pasteable diagnosis. Always
 * exits 0 — absence of an app is a note, not a failure.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerPath, recordLedger } from "./ledger.js";
function claudeDesktopConfigPath() {
    switch (platform()) {
        case "darwin": return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
        case "win32": return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
        default: return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
    }
}
function checkMcpEntry(appName, configPath) {
    if (!existsSync(configPath))
        return { label: appName, status: "skip", detail: "app not detected (config file absent)" };
    try {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        const entry = config.mcpServers?.["context-doctor"];
        if (!entry)
            return { label: appName, status: "fail", detail: `no context-doctor entry in ${configPath} — run: context-doctor install` };
        // Absolute-path entries must point at a file that still exists.
        const target = entry.command === "npx" ? null : entry.args?.[0];
        if (target && !existsSync(target)) {
            return { label: appName, status: "fail", detail: `MCP entry points at missing file ${target} — re-run: context-doctor install` };
        }
        return { label: appName, status: "ok", detail: `MCP wired (${entry.command === "npx" ? "npx, tracks npm releases" : "local build"})` };
    }
    catch (e) {
        return { label: appName, status: "fail", detail: `${configPath} is not valid JSON (${e.message})` };
    }
}
/** Spawn our own MCP server and run the initialize handshake over stdio. */
function checkMcpHandshake() {
    const label = "MCP server handshake";
    const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "mcp.js");
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [mcpPath], { stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => {
            child.kill();
            resolve({ label, status: "fail", detail: "no initialize response within 5s" });
        }, 5000);
        let out = "";
        child.stdout.on("data", (d) => {
            out += d.toString();
            if (out.includes("\n")) {
                clearTimeout(timer);
                child.kill();
                try {
                    const reply = JSON.parse(out.split("\n")[0]);
                    const version = reply.result?.serverInfo?.version;
                    const hasInstructions = typeof reply.result?.instructions === "string" && reply.result.instructions.length > 0;
                    resolve(version && hasInstructions
                        ? { label, status: "ok", detail: `v${version} responds; standing instructions present` }
                        : { label, status: "fail", detail: "handshake reply missing serverInfo/instructions" });
                }
                catch {
                    resolve({ label, status: "fail", detail: "unparseable handshake reply" });
                }
            }
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ label, status: "fail", detail: e.message });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "1" } } }) + "\n");
    });
}
export async function runDoctor() {
    const checks = [];
    checks.push(checkMcpEntry("Claude Desktop", claudeDesktopConfigPath()));
    checks.push(checkMcpEntry("Claude Code", join(homedir(), ".claude.json")));
    checks.push(checkMcpEntry("Cursor", join(homedir(), ".cursor", "mcp.json")));
    // Hook registration
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
            const registered = JSON.stringify(settings.hooks?.UserPromptSubmit ?? []).includes("context-doctor");
            checks.push(registered
                ? { label: "Every-prompt hook", status: "ok", detail: "registered in ~/.claude/settings.json" }
                : { label: "Every-prompt hook", status: "fail", detail: "not registered — run: context-doctor install" });
        }
        catch (e) {
            checks.push({ label: "Every-prompt hook", status: "fail", detail: `settings.json unreadable (${e.message})` });
        }
    }
    else {
        checks.push({ label: "Every-prompt hook", status: "skip", detail: "Claude Code not detected" });
    }
    // Skill
    const skillPath = join(homedir(), ".claude", "skills", "context-doctor", "SKILL.md");
    checks.push(existsSync(skillPath)
        ? { label: "Agent Skill", status: "ok", detail: skillPath }
        : { label: "Agent Skill", status: "skip", detail: "not installed (run context-doctor install on a Claude Code machine)" });
    // Ledger writable
    try {
        recordLedger({ ev: "check", sid: "doctor-probe", tok: 0, warn: false });
        checks.push({ label: "Ledger", status: "ok", detail: `writable at ${ledgerPath()}` });
    }
    catch {
        checks.push({ label: "Ledger", status: "fail", detail: `cannot write ${ledgerPath()}` });
    }
    checks.push(await checkMcpHandshake());
    const mark = { ok: "✓", fail: "✗", skip: "–" };
    console.log("CONTEXT DOCTOR — self-check");
    console.log("═".repeat(56));
    for (const c of checks) {
        console.log(`${mark[c.status]} ${c.label.padEnd(22)} ${c.detail}`);
    }
    const fails = checks.filter((c) => c.status === "fail");
    console.log("");
    console.log(fails.length === 0 ? "All good." : `${fails.length} issue(s) found — fixes suggested above.`);
}
