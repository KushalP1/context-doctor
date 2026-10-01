// Render real terminal output as an SVG "window" for the README.
// Usage: node dist/cli.js savings | node scripts/render-terminal-svg.mjs "npx context-doctor savings" > assets/savings.svg
import { readFileSync } from "node:fs";
const command = process.argv[2] ?? "";
const body = readFileSync(0, "utf8").replace(/\s+$/, "").split("\n");
const lines = [{ text: `$ ${command}`, cls: "cmd" }, { text: "", cls: "" }, ...body.map((t, i) => ({ text: t, cls: i === 0 ? "title" : /^\s*[─━]+$/.test(t) ? "rule" : /^\d\. /.test(t) ? "item" : "" }))];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const charW = 8.8, lineH = 20, padX = 22, top = 46;
const cols = Math.max(...lines.map((l) => [...l.text].length));
const width = Math.ceil(cols * charW + padX * 2);
const height = top + lines.length * lineH + 18;
const money = (s) => esc(s).replace(/(\$[\d,]*\d(?:\.\d+)?)/g, '<tspan class="money">$1</tspan>');
const rows = lines.map((l, i) => `<text x="${padX}" y="${top + i * lineH}" class="${l.cls}" xml:space="preserve">${l.cls === "cmd" ? esc(l.text) : money(l.text)}</text>`).join("\n  ");
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="context-doctor savings output">
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; fill: #d6dde8; }
    .cmd { fill: #7ee2b8; } .title { fill: #ffffff; font-weight: 600; } .rule { fill: #4b5563; }
    .item { fill: #ffffff; font-weight: 600; } .money { fill: #fbbf24; font-weight: 600; }
  </style>
  <rect width="${width}" height="${height}" rx="10" fill="#0f172a"/>
  <circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
  ${rows}
</svg>
`);
