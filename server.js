
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PEERS_FILE = path.join(DATA_DIR, "peers.json");
const POSTS_FILE = path.join(DATA_DIR, "posts.json");
const NODE_ID_FILE = path.join(DATA_DIR, "node-id");

const NETWORK_SECRET = process.env.NETWORK_SECRET || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://node-base.base44.app"
).split(",").map(origin => origin.trim().replace(/\/+$/, ""));

const MAX_POSTS = 10000;
const MAX_PEERS = 100;
const MAX_SYNC_HOPS = 3;

fs.mkdirSync(DATA_DIR, { recursive: true });

function initializeFile(file, value) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  }
}

initializeFile(PEERS_FILE, []);
initializeFile(POSTS_FILE, []);

if (!fs.existsSync(NODE_ID_FILE)) {
  fs.writeFileSync(NODE_ID_FILE, crypto.randomUUID());
}

const NODE_ID = fs.readFileSync(NODE_ID_FILE, "utf8").trim();
const startedAt = Date.now();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// CORS configuration
app.use((req, res, next) => {
  const origin = (req.get("Origin") || "").replace(/\/+$/, "");

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Network-Secret"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Persistent JSON storage
function readJSON(file, fallback = []) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function getPeers() {
  return readJSON(PEERS_FILE);
}

function getPosts() {
  return readJSON(POSTS_FILE);
}

function savePeers(peers) {
  writeJSON(PEERS_FILE, peers);
}

function savePosts(posts) {
  writeJSON(POSTS_FILE, posts.slice(-MAX_POSTS));
}

// Network authentication
function requireNetworkSecret(req, res, next) {
  if (!NETWORK_SECRET) {
    return res.status(503).json({
      error: "Network authentication is not configured."
    });
  }

  const supplied = Buffer.from(req.get("X-Network-Secret") || "");
  const expected = Buffer.from(NETWORK_SECRET);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({
      error: "Invalid network credentials."
    });
  }

  next();
}

// Public post rate limiting
const requestCounts = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now - entry.time >= 60000) {
    requestCounts.set(ip, { time: now, count: 1 });
    return next();
  }

  entry.count++;

  if (entry.count > 20) {
    return res.status(429).json({
      error: "Too many requests. Try again later."
    });
  }

  next();
}

// Validate incoming posts
function validPost(post) {
  return Boolean(
    post &&
    typeof post.id === "string" &&
    post.id.length > 0 &&
    post.id.length <= 100 &&
    typeof post.content === "string" &&
    post.content.trim().length > 0 &&
    post.content.length <= 5000 &&
    typeof post.author === "string" &&
    post.author.trim().length > 0 &&
    post.author.length <= 100 &&
    typeof post.originNode === "string" &&
    post.originNode.length <= 100 &&
    typeof post.createdAt === "string" &&
    Number.isFinite(Date.parse(post.createdAt))
  );
}

// Merge posts without duplicates
function mergePosts(incoming) {
  const existing = getPosts();
  const ids = new Set(existing.map(post => post.id));
  const added = [];

  for (const post of incoming) {
    if (!validPost(post) || ids.has(post.id)) {
      continue;
    }

    ids.add(post.id);
    added.push(post);
  }

  if (added.length) {
    savePosts([...existing, ...added]);
  }

  return added;
}

// Synchronize posts with registered peers
async function broadcastPosts(posts, hops = 0, excludedUrl = null) {
  if (!NETWORK_SECRET || hops >= MAX_SYNC_HOPS) {
    return;
  }

  const peers = getPeers();

  await Promise.allSettled(
    peers
      .filter(peer => peer.url !== excludedUrl)
      .map(async peer => {
        try {
          const response = await fetch(`${peer.url}/api/sync`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Network-Secret": NETWORK_SECRET
            },
            body: JSON.stringify({
              posts,
              hops: hops + 1,
              sourceUrl: PUBLIC_URL || null
            }),
            signal: AbortSignal.timeout(5000),
            redirect: "manual"
          });

          if (!response.ok) {
            console.warn(
              `Peer ${peer.name} returned ${response.status}`
            );
          }
        } catch (error) {
          console.warn(
            `Could not reach peer ${peer.name}: ${error.message}`
          );
        }
      })
  );
}

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    service: "FriendCodeForum Node",
    decentralized: true,
    nodeId: NODE_ID,
    timestamp: new Date().toISOString()
  });
});

// NODE STATUS
app.get("/api/status", (req, res) => {
  const peers = getPeers();
  const posts = getPosts();

  res.json({
    name: "FriendCodeForum Node",
    id: NODE_ID,
    url: PUBLIC_URL || null,
    status: "online",
    version: "3.0.0",
    decentralized: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    peers: peers.length,
    posts: posts.length,
    networkAuthenticated: Boolean(NETWORK_SECRET),
    timestamp: new Date().toISOString()
  });
});

// LIST PEERS
app.get("/api/peers", (req, res) => {
  res.json({
    nodeId: NODE_ID,
    peers: getPeers()
  });
});

// REGISTER PEER
app.post("/api/peers", requireNetworkSecret, (req, res) => {
  const { name, url } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    typeof url !== "string" ||
    url.length > 300
  ) {
    return res.status(400).json({
      error: "Valid peer name and URL required."
    });
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({
      error: "Invalid peer URL."
    });
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    parsed.port
  ) {
    return res.status(400).json({
      error: "Peer must use a clean HTTPS origin."
    });
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return res.status(400).json({
      error: "Local peers are not allowed."
    });
  }

  const peerURL = parsed.origin;

  if (
    peerURL === PUBLIC_URL ||
    peerURL === `https://${req.get("host")}`
  ) {
    return res.status(400).json({
      error: "Cannot register this node as its own peer."
    });
  }

  const peers = getPeers();

  if (peers.some(peer => peer.url === peerURL)) {
    return res.status(409).json({
      error: "Peer already registered."
    });
  }

  if (peers.length >= MAX_PEERS) {
    return res.status(400).json({
      error: "Peer limit reached."
    });
  }

  const peer = {
    id: crypto.randomUUID(),
    name: name.trim(),
    url: peerURL,
    registeredAt: new Date().toISOString()
  };

  peers.push(peer);
  savePeers(peers);

  res.status(201).json({
    success: true,
    peer
  });
});

// REMOVE PEER
app.delete(
  "/api/peers/:id",
  requireNetworkSecret,
  (req, res) => {
    const peers = getPeers();
    const updated = peers.filter(
      peer => peer.id !== req.params.id
    );

    if (updated.length === peers.length) {
      return res.status(404).json({
        error: "Peer not found."
      });
    }

    savePeers(updated);
    res.json({ success: true });
  }
);

// READ FORUM POSTS
app.get("/api/posts", (req, res) => {
  const posts = getPosts();

  const since = req.query.since
    ? Date.parse(req.query.since)
    : 0;

  if (req.query.since && !Number.isFinite(since)) {
    return res.status(400).json({
      error: "Invalid since timestamp."
    });
  }

  const filtered = posts.filter(
    post => Date.parse(post.createdAt) > since
  );

  res.json({
    nodeId: NODE_ID,
    count: posts.length,
    posts: filtered
  });
});

// PUBLISH FORUM POST
app.post("/api/posts", rateLimit, async (req, res) => {
  const { author, content } = req.body || {};

  if (
    typeof author !== "string" ||
    !author.trim() ||
    author.length > 100 ||
    typeof content !== "string" ||
    !content.trim() ||
    content.length > 5000
  ) {
    return res.status(400).json({
      error: "Valid author and post content required."
    });
  }

  const post = {
    id: crypto.randomUUID(),
    author: author.trim(),
    content: content.trim(),
    originNode: NODE_ID,
    createdAt: new Date().toISOString()
  };

  const posts = getPosts();
  posts.push(post);
  savePosts(posts);

  broadcastPosts([post]).catch(console.error);

  res.status(201).json({
    success: true,
    post
  });
});

// RECEIVE POSTS FROM OTHER NODES
app.post("/api/sync", requireNetworkSecret, (req, res) => {
  const { posts, hops = 0 } = req.body || {};

  if (
    !Array.isArray(posts) ||
    posts.length > 100 ||
    !Number.isInteger(hops) ||
    hops < 0 ||
    hops > MAX_SYNC_HOPS
  ) {
    return res.status(400).json({
      error: "Invalid synchronization request."
    });
  }

  if (!posts.every(validPost)) {
    return res.status(400).json({
      error: "Invalid post data."
    });
  }

  const added = mergePosts(posts);

  if (added.length && hops < MAX_SYNC_HOPS) {
    broadcastPosts(
      added,
      hops,
      req.body.sourceUrl || null
    ).catch(console.error);
  }

  res.json({
    success: true,
    nodeId: NODE_ID,
    received: posts.length,
    added: added.length
  });
});

// START SERVER
app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log(" FriendCodeForum Node 3.0");
  console.log("--------------------------------");
  console.log("Node ID:", NODE_ID);
  console.log("Port:", PORT);
  console.log("Network authentication:",
    NETWORK_SECRET ? "Enabled" : "Not configured");
  console.log("Allowed origins:", ALLOWED_ORIGINS);
  console.log("Peers:", getPeers().length);
  console.log("Posts:", getPosts().length);
  console.log("--------------------------------");
});
