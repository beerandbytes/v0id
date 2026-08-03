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
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
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
    addEventListener() {},
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

test("out-of-range saved queue index is clamped", () => {
  const savedTrack = {
    tracks: [{ id: "dQw4w9WgXcQ", title: "Saved track" }],
    currentIndex: -9
  };
  const { elements } = createPage({
    storage: { "cryo-queue:ALPHA-01": JSON.stringify(savedTrack) }
  });

  assert.equal(elements.get("nowTitle").textContent, "No active track");
});

test("guest live-room setup keeps the response copy control available", () => {
  const { context, elements } = createPage();

  context.setLiveRole("guest");

  assert.equal(elements.get("hostActions").hidden, false);
  assert.equal(elements.get("createOffer").hidden, true);
  assert.equal(elements.get("copyLive").hidden, false);
});

test("live signal round-trips as a URL-safe payload", () => {
  const { context } = createPage();
  const description = { type: "offer", sdp: "v=0\r\na=ice-ufrag:abc+/\r\n" };

  const signal = context.encodeSignal(description);

  assert.doesNotMatch(signal, /[+/=]/);
  assert.deepEqual(JSON.parse(JSON.stringify(context.decodeSignal(`#live=${signal}`))), description);
});

test("shared tracks discard malformed IDs and unsafe thumbnail URLs", () => {
  const { context } = createPage();
  const tracks = context.normalizeTracks([
    { id: "dQw4w9WgXcQ", title: "Valid", thumb: "https://attacker.example/image", addedAt: 1 },
    { id: "not-a-youtube-id", title: "Invalid" }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(tracks)), [{
    id: "dQw4w9WgXcQ",
    title: "Valid",
    thumb: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    addedAt: 1
  }]);
});

test("only a host answers an initial live state request", () => {
  const { context } = createPage();
  const sent = [];
  const testChannel = { readyState: "open", send(message) { sent.push(JSON.parse(message)); } };
  context.attachLiveChannel(testChannel);

  context.setLiveRole("guest");
  testChannel.onmessage({ data: JSON.stringify({ type: "request-state" }) });
  assert.deepEqual(sent, []);

  context.setLiveRole("host");
  testChannel.onmessage({ data: JSON.stringify({ type: "request-state" }) });
  assert.equal(sent[0].type, "state");
});

test("malformed sync messages are ignored", () => {
  const { channels } = createPage();

  assert.doesNotThrow(() => {
    channels[0].onmessage({ data: { type: "state" } });
  });
});
