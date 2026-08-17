/**
 * One-command setup: `context-doctor install`
 *
 * Detects the AI apps present on this machine and wires the context-doctor
 * MCP server into each, plus installs the Agent Skill for Claude Code.
 * Every config edit is a careful JSON merge with a .backup file written first.
 * `context-doctor uninstall` reverses it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function claudeDesktopConfigPath() {
    switch (platform()) {
        case "darwin": return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
        case "win32": return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
        default: return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
    }
}
function targets() {
    const desktop = claudeDesktopConfigPath();
    const claudeCode = join(homedir(), ".claude.json");
    const cursor = join(homedir(), ".cursor", "mcp.json");
    return [
        { name: "Claude Desktop", configPath: desktop, detect: () => existsSync(dirname(desktop)) },
        { name: "Claude Code", configPath: claudeCode, detect: () => existsSync(claudeCode) || existsSync(join(homedir(), ".claude")) },
        { name: "Cursor", configPath: cursor, detect: () => existsSync(join(homedir(), ".cursor")) },
    ];
}
/**
 * The server command to write into configs. When running from a published
 * install, npx keeps it auto-updating; from a local checkout, point at the
 * built file directly so it works before the package is on npm.
 */
function serverEntry() {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const localMcp = join(selfDir, "mcp.js");
    const runningFromNpx = (process.env.npm_execpath ?? "").includes("npx") || selfDir.includes("_npx");
    if (!runningFromNpx && existsSync(localMcp)) {
        return { command: process.execPath, args: [localMcp] };
    }
    return { command: "npx", args: ["-y", "context-doctor-mcp"] };
}
function readJson(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch (e) {
        throw new Error(`${path} exists but is not valid JSON — fix or remove it first (${e.message})`);
    }
}
function writeJsonWithBackup(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path))
        copyFileSync(path, path + ".context-doctor.backup");
    writeFileSync(path, JSON.stringify(data, null, 2));
}
/** Shell command used for the Claude Code every-prompt hook. */
function hookCommand() {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const localCli = join(selfDir, "cli.js");
    const runningFromNpx = (process.env.npm_execpath ?? "").includes("npx") || selfDir.includes("_npx");
    if (!runningFromNpx && existsSync(localCli)) {
        return `"${process.execPath}" "${localCli}" hook`;
    }
    return "npx -y context-doctor hook";
}
const HOOK_MARKER = "context-doctor";
/**
 * Register the UserPromptSubmit hook in ~/.claude/settings.json so EVERY
 * Claude Code query gets a context-size check. Idempotent.
 */
function installHook() {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(join(homedir(), ".claude")))
        return null; // no Claude Code here
    const settings = readJson(settingsPath);
    settings.hooks = settings.hooks ?? {};
    const entries = settings.hooks.UserPromptSubmit ?? [];
    const already = entries.some((e) => JSON.stringify(e).includes(HOOK_MARKER));
    if (!already) {
        entries.push({ hooks: [{ type: "command", command: hookCommand() }] });
        settings.hooks.UserPromptSubmit = entries;
        writeJsonWithBackup(settingsPath, settings);
    }
    return settingsPath;
}
function uninstallHook() {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath))
        return;
    const settings = readJson(settingsPath);
    const entries = settings.hooks?.UserPromptSubmit;
    if (!entries)
        return;
    const filtered = entries.filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
    if (filtered.length !== entries.length) {
        settings.hooks.UserPromptSubmit = filtered;
        if (filtered.length === 0)
            delete settings.hooks.UserPromptSubmit;
        writeJsonWithBackup(settingsPath, settings);
        console.log("✓ Claude Code every-prompt hook removed");
    }
}
function installSkill() {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    // dist/install.js → package root is one level up; skills/ ships in the package.
    const skillSource = join(selfDir, "..", "skills", "context-doctor", "SKILL.md");
    if (!existsSync(skillSource))
        return null;
    const skillDest = join(homedir(), ".claude", "skills", "context-doctor");
    mkdirSync(skillDest, { recursive: true });
    copyFileSync(skillSource, join(skillDest, "SKILL.md"));
    return join(skillDest, "SKILL.md");
}
export function runInstall() {
    const entry = serverEntry();
    const found = targets().filter((t) => t.detect());
    if (found.length === 0) {
        console.log("No supported AI apps detected (Claude Desktop, Claude Code, Cursor).");
        console.log("Manual setup — add to your app's MCP config:");
        console.log(JSON.stringify({ mcpServers: { "context-doctor": entry } }, null, 2));
        return;
    }
    for (const target of found) {
        try {
            const config = readJson(target.configPath);
            config.mcpServers = config.mcpServers ?? {};
            config.mcpServers["context-doctor"] = entry;
            writeJsonWithBackup(target.configPath, config);
            console.log(`✓ ${target.name}: MCP server added (${target.configPath})`);
        }
        catch (e) {
            console.error(`✗ ${target.name}: ${e.message}`);
        }
    }
    const skillPath = installSkill();
    if (skillPath)
        console.log(`✓ Agent Skill installed for Claude Code (${skillPath})`);
    const hookPath = installHook();
    if (hookPath)
        console.log(`✓ Claude Code every-prompt hook installed (${hookPath}) — heavy sessions get automatic hygiene guidance`);
    console.log("\nDone. Restart the apps to pick up the new tools, then try:");
    console.log('  "What\'s eating my context?" — or paste a conversation and ask for a profile.');
}
export function runUninstall() {
    for (const target of targets().filter((t) => t.detect())) {
        try {
            if (!existsSync(target.configPath))
                continue;
            const config = readJson(target.configPath);
            if (config.mcpServers?.["context-doctor"]) {
                delete config.mcpServers["context-doctor"];
                writeJsonWithBackup(target.configPath, config);
                console.log(`✓ ${target.name}: MCP server removed`);
            }
        }
        catch (e) {
            console.error(`✗ ${target.name}: ${e.message}`);
        }
    }
    const skillDir = join(homedir(), ".claude", "skills", "context-doctor");
    if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true });
        console.log("✓ Agent Skill removed");
    }
    uninstallHook();
    console.log("Done.");
}
