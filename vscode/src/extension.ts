/**
 * VS Code / Cursor extension: context-doctor's status line, inside the editor.
 *
 * Reads the newest Claude Code transcript for the open workspace and shows the
 * live context size, share of window, and cache share in the status bar,
 * refreshed on a timer and on file changes. Clicking runs
 * `npx -y context-doctor session` on that transcript in a terminal.
 */

import * as vscode from "vscode";
import { statusForWorkspace } from "./core";

let item: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastTranscript: string | undefined;

function refresh(): void {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    item.hide();
    return;
  }
  const cfg = vscode.workspace.getConfiguration("contextDoctor");
  const warnAt = cfg.get<number>("warnAtPercent", 70);
  const result = statusForWorkspace(folder, warnAt);
  lastTranscript = result.transcript;
  if (!result.status) {
    item.text = "$(pulse) ctx —";
    item.tooltip = `context-doctor: ${result.reason}`;
    item.backgroundColor = undefined;
    item.show();
    return;
  }
  item.text = result.status.text;
  item.tooltip = result.status.tooltip;
  item.backgroundColor = result.status.warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  item.show();
}

function schedule(): void {
  if (timer) clearInterval(timer);
  const seconds = vscode.workspace.getConfiguration("contextDoctor").get<number>("refreshSeconds", 5);
  timer = setInterval(refresh, Math.max(1, seconds) * 1000);
}

export function activate(context: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  item.command = "contextDoctor.showSession";
  item.name = "context-doctor";
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand("contextDoctor.refresh", refresh),
    vscode.commands.registerCommand("contextDoctor.showSession", () => {
      const terminal = vscode.window.createTerminal({ name: "context-doctor" });
      terminal.show();
      // Quote the path: transcripts live under a directory derived from the workspace path.
      terminal.sendText(lastTranscript ? `npx -y context-doctor session "${lastTranscript}"` : "npx -y context-doctor session");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("contextDoctor")) {
        schedule();
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh)
  );

  refresh();
  schedule();
}

export function deactivate(): void {
  if (timer) clearInterval(timer);
}
