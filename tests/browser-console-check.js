const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const candidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

const browserPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  throw new Error("No Chrome or Edge executable found for browser console check.");
}

const port = 9333 + Math.floor(Math.random() * 1000);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryo-queue-browser-"));
const pageUrl = `file:///${path.resolve(__dirname, "..", "index.html").replaceAll("\\", "/")}`;
const browser = spawn(browserPath, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  pageUrl
], { stdio: "ignore" });

function getJson(route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: route }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson("/json/list");
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("file:///"));
      if (page) return page;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for browser target.");
}

async function run() {
  const target = await waitForTarget();
  const messages = [];
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocket(target.webSocketDebuggerUrl);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      messages.push(message.params.exceptionDetails.text);
    }
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
      messages.push(message.params.args.map((arg) => arg.value || arg.description || "").join(" "));
    }
    if (message.method === "Log.entryAdded" && ["error", "warning"].includes(message.params.entry.level)) {
      messages.push(message.params.entry.text);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  }

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  socket.close();

  const actionable = messages.filter((message) => !message.includes("youtube.com/iframe_api"));
  assert.deepEqual(actionable, []);
  console.log("ok - browser console has no page runtime errors");
}

run()
  .finally(async () => {
    browser.kill();
    await new Promise((resolve) => browser.once("exit", resolve));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  })
  .catch((error) => {
    console.error("not ok - browser console has no page runtime errors");
    console.error(error);
    process.exitCode = 1;
  });
