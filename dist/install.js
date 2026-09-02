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
import { delimiter, dirname, join, sep } from "node:path";
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
 * The server command to write into configs.
 *
 * Never write `process.execPath`: on Homebrew, nvm and asdf that is a
 * VERSION-PINNED path (…/node/25.6.0/bin/node), so the next Node upgrade
 * silently breaks every config we wrote — the apps simply stop showing the
 * tools, with no error to explain why. `node` from PATH survives upgrades.
 *
 * Installed from npm → npx, which also picks up package updates. Local
 * checkout → the built file, so the repo works before/without publishing.
 */
function serverEntry() {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const localMcp = join(selfDir, "mcp.js");
    const fromPackage = selfDir.includes(`${sep}node_modules${sep}`) || selfDir.includes("_npx");
    if (!fromPackage && existsSync(localMcp)) {
        // `node` is node.exe on Windows — directly spawnable, no shell needed.
        return { command: "node", args: [localMcp] };
    }
    return npxLauncher(platform());
}
/**
 * How to invoke the published package as an MCP server on a given platform.
 *
 * On Windows npx is `npx.cmd` — a batch script, not an executable. MCP clients
 * spawn their server directly, without a shell, so a bare "npx" fails with
 * ENOENT and the app simply shows no tools and no error. Hence the cmd /c
 * wrapper that every working Windows MCP config uses.
 *
 * Exported so the platform branch is testable from any host OS.
 */
export function npxLauncher(platformName) {
    return platformName === "win32"
        ? { command: "cmd", args: ["/c", "npx", "-y", "context-doctor-mcp"] }
        : { command: "npx", args: ["-y", "context-doctor-mcp"] };
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
/**
 * Find an executable on PATH without shelling out (works on Windows too).
 * Used to prefer a global `context-doctor` install for the hook: a stable
 * location that survives both package updates and Node upgrades.
 */
function binOnPath(name) {
    const exts = platform() === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            const candidate = join(dir, name + ext);
            if (existsSync(candidate))
                return candidate;
        }
    }
    return null;
}
/**
 * Shell command used for the Claude Code every-prompt hook.
 *
 * The hook runs on EVERY prompt, so the command must be both fast and durable.
 * In preference order:
 *   1. a local checkout's built cli.js — absolute, stable, zero resolution cost;
 *   2. a global `context-doctor` binary on PATH — same, for npm -g installs;
 *   3. `npx -y context-doctor hook` — last resort.
 *
 * Critically, a path inside npx's `_npx` cache is NEVER written: npm garbage-
 * collects that directory, and the hook would then fail silently on every
 * prompt. `node` (not process.execPath) keeps it alive across Node upgrades.
 */
function hookCommand() {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const localCli = join(selfDir, "cli.js");
    const ephemeral = selfDir.includes("_npx");
    if (!ephemeral && existsSync(localCli))
        return `node "${localCli}" hook`;
    const global = binOnPath("context-doctor");
    if (global)
        return `"${global}" hook`;
    return "npx -y context-doctor hook";
}
/** True when the hook had to fall back to npx — worth telling the user. */
function hookUsesNpx() {
    return hookCommand().startsWith("npx ");
}
const HOOK_MARKER = "context-doctor";
/**
 * Is this settings.json hook entry ours?
 *
 * Usually the command contains "context-doctor" (npx form, or a path through
 * the package directory). A repo cloned into a differently-named folder does
 * not, so a command ending in `cli.js hook` counts too — specific enough not
 * to claim an unrelated hook.
 */
function isOurHookEntry(entry) {
    const raw = JSON.stringify(entry ?? "");
    if (raw.includes(HOOK_MARKER))
        return true;
    const command = String(entry?.hooks?.[0]?.command ?? "");
    return /(cli\.js|context-doctor(\.cmd|\.exe|\.bat)?)"?\s+hook\s*$/.test(command);
}
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
    const want = hookCommand();
    // Re-running install must REPAIR a stale entry, not skip it. Earlier versions
    // wrote a version-pinned node binary; if we only checked "is it present?" an
    // upgrade would leave that broken command in place forever.
    const ours = entries.filter(isOurHookEntry);
    const current = ours[0]?.hooks?.[0]?.command;
    if (ours.length === 0) {
        entries.push({ hooks: [{ type: "command", command: want }] });
    }
    else if (current !== want) {
        // Replace every entry of ours with exactly one correct entry.
        const others = entries.filter((e) => !isOurHookEntry(e));
        others.push({ hooks: [{ type: "command", command: want }] });
        settings.hooks.UserPromptSubmit = others;
        writeJsonWithBackup(settingsPath, settings);
        return settingsPath;
    }
    else {
        return settingsPath; // already correct — leave the file untouched
    }
    settings.hooks.UserPromptSubmit = entries;
    writeJsonWithBackup(settingsPath, settings);
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
    const filtered = entries.filter((e) => !isOurHookEntry(e));
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
            // Always overwrite: re-running install is how a stale entry gets repaired.
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
    if (hookPath) {
        console.log(`✓ Claude Code every-prompt hook installed (${hookPath}) — heavy sessions get automatic hygiene guidance`);
        // npx resolves the package on every single prompt; a global install makes
        // the hook a plain exec instead, which is both faster and update-proof.
        if (hookUsesNpx()) {
            console.log("  note: the hook falls back to npx. For a faster, permanent hook: npm i -g context-doctor && context-doctor install");
        }
    }
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
    // Remove our bookkeeping files too — uninstall means gone.
    for (const file of [".context-doctor-hook-state.json", ".context-doctor-ledger.jsonl"]) {
        const p = join(homedir(), ".claude", file);
        if (existsSync(p)) {
            rmSync(p);
            console.log(`✓ Removed ${file}`);
        }
    }
    console.log("Done.");
}
