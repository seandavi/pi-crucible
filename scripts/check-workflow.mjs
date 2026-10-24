// Syntax check for workflows/crucible.js. The sandbox runs the script as the body of an async
// function (top-level await and return), so wrap it the same way and let node parse it.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const path = new URL("../workflows/crucible.js", import.meta.url);
const body = readFileSync(path, "utf8");
new vm.Script(`(async function (args, runs) {\n${body}\n})`, { filename: path.pathname });
console.log("workflows/crucible.js parses");
