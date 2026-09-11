// run-experimental.js
//
// Runs server.js with a few lines patched in memory. The real server.js
// file on disk is never modified. Add this file (and the generated
// experimental db/html) to .gitignore if you don't want it tracked.
//
// Usage: node run-experimental.js

const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'server.js');
let src = fs.readFileSync(target, 'utf8');

const patches = [
    {
        find: "new Database('./data.db')",
        replace: "new Database('./data_experimental.db')",
    },
    {
        find: "const PORT = 3000;",
        replace: "const PORT = 3333;",
    },
    {
        find: "res.sendFile(path.join(__dirname, 'login.html'));",
        replace: "res.sendFile(path.join(__dirname, 'login_experimental.html'));",
    },
    {
        find: "res.sendFile(path.join(__dirname, 'register.html'));",
        replace: "res.sendFile(path.join(__dirname, 'register_experimental.html'));",
    },
    {
        // Rename the route instead of deleting it, so the file still parses
        // cleanly and there's zero risk of mismatched braces. Nothing in
        // the app links to this path anymore, so it's effectively disabled.
        find: "app.post('/register', authLimiter, async (req, res) => {",
        replace: "app.post('/register-disabled-experimental', authLimiter, async (req, res) => {",
    },
];

for (const { find, replace } of patches) {
    const count = src.split(find).length - 1;
    if (count === 0) {
        throw new Error(`Patch target not found (did server.js change?): ${find}`);
    }
    if (count > 1) {
        throw new Error(`Patch target matched ${count} times, expected 1: ${find}`);
    }
    src = src.replace(find, replace);
}

// Compile the patched source as if it were server.js itself, so require(),
// __dirname, __filename, and relative paths all resolve exactly the same
// way they would if you'd edited the real file.
const mod = new Module(target, module);
mod.filename = target;
mod.paths = Module._nodeModulePaths(path.dirname(target));
mod._compile(src, target);