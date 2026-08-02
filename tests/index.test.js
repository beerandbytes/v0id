const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.classList = {
      add() {},
      remove() {}
    };
  }

  addEventListener(type, handler) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners[type] || []) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        ...event
      });
    }
  }

  removeAttribute(name) {
    delete this[name];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector) {
    if (selector !== "button") return [];
    return ["up", "down", "delete"].map((action) => {
      const button = new FakeElement();
      button.dataset.action = action;
      return button;
    });
  }
}

function createPage({ storage = {}, broadcastChannel = true, localStorage = true } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();

  function elementFor(selector) {
    const id = selector.startsWith("#") ? selector.slice(1) : selector;
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }

  const context = {
    console,
    URL,
    Date,
    Number,
    String,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    fetch: async () => ({ ok: false })
  };

  if (localStorage) {
    context.localStorage = {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
      },
      setItem(key, value) {
        storage[key] = value;
      }
    };
  }

  const channels = [];
  if (broadcastChannel) {
    context.BroadcastChannel = class {
      constructor(name) {
        this.name = name;
        channels.push(this);
      }
      postMessage() {}
      close() {}
    };
  }

  context.document = {
    querySelector: elementFor,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    head: {
      appendChild() {}
    }
  };

  context.window = context;
  vm.runInNewContext(script, context);
  return { context, elements, storage, channels };
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("play before YouTube API readiness does not throw", () => {
  const savedTrack = {
    tracks: [{ id: "dQw4w9WgXcQ", title: "Saved track", thumb: "thumb.jpg" }],
    currentIndex: 0
  };
  const { elements } = createPage({
    storage: { "cryo-queue:ALPHA-01": JSON.stringify(savedTrack) }
  });

  assert.doesNotThrow(() => elements.get("playBtn").dispatch("click"));
});

test("invalid saved room state does not break page initialization", () => {
  assert.doesNotThrow(() => {
    createPage({ storage: { "cryo-queue:ALPHA-01": "not-json" } });
  });
});

test("wrong-shaped saved room state starts with an empty queue", () => {
  assert.doesNotThrow(() => {
    createPage({
      storage: { "cryo-queue:ALPHA-01": JSON.stringify({ tracks: {}, currentIndex: "0" }) }
    });
  });
});

test("missing BroadcastChannel starts in local-only mode", () => {
  assert.doesNotThrow(() => {
    createPage({ broadcastChannel: false });
  });
});

test("missing localStorage starts with an empty queue", () => {
  assert.doesNotThrow(() => {
    createPage({ localStorage: false });
  });
});

test("malformed sync messages are ignored", () => {
  const { channels } = createPage();

  assert.doesNotThrow(() => {
    channels[0].onmessage({ data: { type: "state" } });
  });
});
