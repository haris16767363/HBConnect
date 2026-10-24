
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10_000
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

const waiting = new Map();
const paired = new Map();
const blocked = new Map();
const reports = new Map();

const allowedGenders = ["male", "female"];
const allowedCountries = [
  "PK", "IN", "US", "GB", "CA", "AE",
  "SA", "TR", "BD", "OTHER"
];

function validCountry(value) {
  return allowedCountries.includes(value) ? value : "OTHER";
}

function compatible(a, b) {
  if (a.id === b.id) return false;

  if (a.genderPref !== "any" &&
      a.genderPref !== b.gender) return false;

  if (b.genderPref !== "any" &&
      b.genderPref !== a.gender) return false;

  if (a.countryPref !== "any" &&
      a.countryPref !== b.country) return false;

  if (b.countryPref !== "any" &&
      b.countryPref !== a.country) return false;

  if (blocked.get(a.id)?.has(b.id)) return false;
  if (blocked.get(b.id)?.has(a.id)) return false;

  return true;
}

function removeFromQueue(id) {
  waiting.delete(id);
}

function clearPair(id, reason = "ended") {
  const other = paired.get(id);
  removeFromQueue(id);

  if (!other) return;

  paired.delete(id);
  paired.delete(other);

  io.to(other).emit("partner_left", { reason });
  io.to(id).emit("match_cancelled", { reason });
}

function findMatch(socket, preferences) {
  const id = socket.id;
  removeFromQueue(id);

  if (paired.has(id)) return;

  const me = { id, ...preferences };
  let match = null;

  for (const candidate of waiting.values()) {
    if (compatible(me, candidate)) {
      match = candidate;
      break;
    }
  }

  if (!match) {
    waiting.set(id, me);
    socket.emit("searching");
    return;
  }

  waiting.delete(match.id);

  paired.set(id, match.id);
  paired.set(match.id, id);

  const initiator = id.localeCompare(match.id) < 0;

  socket.emit("match_found", {
    peer: match.id,
    country: match.country
  });

  io.to(match.id).emit("match_found", {
    peer: id,
    country: me.country
  });

  socket.emit("call_ready", { initiator });
  io.to(match.id).emit("call_ready", {
    initiator: !initiator
  });
}

io.on("connection", socket => {
  socket.emit("connected");

  socket.on("find", data => {
    if (paired.has(socket.id)) return;

    const gender = allowedGenders.includes(data?.gender)
      ? data.gender : "male";

    const genderPref = ["male", "female", "any"]
      .includes(data?.genderPref) ? data.genderPref : "any";

    const country = validCountry(data?.country);

    const countryPref = data?.countryPref === "any"
      ? "any" : validCountry(data?.countryPref);

    findMatch(socket, {
      gender,
      genderPref,
      country,
      countryPref
    });
  });

  socket.on("leave_match", () => {
    clearPair(socket.id, "ended");
  });

  // Forward call signals only to the current partner.
  ["webrtc_offer", "webrtc_answer", "ice_candidate"]
    .forEach(event => {
      socket.on(event, data => {
        const other = paired.get(socket.id);
        if (!other || !data) return;

        io.to(other).emit(event, data);
      });
    });

  // Text chat: no message history is saved.
  socket.on("chat_message", data => {
    const other = paired.get(socket.id);
    if (!other || typeof data?.text !== "string") return;

    const text = data.text.trim().slice(0, 500);
    if (!text) return;

    io.to(other).emit("chat_message", {
      text,
      time: Date.now()
    });
  });

  socket.on("block_user", () => {
    const other = paired.get(socket.id);
    if (!other) return;

    if (!blocked.has(socket.id)) {
      blocked.set(socket.id, new Set());
    }

    blocked.get(socket.id).add(other);
    clearPair(socket.id, "blocked");
    socket.emit("block_success");
  });

  socket.on("report_user", data => {
    const other = paired.get(socket.id);
    if (!other) return;

    const reasons = [
      "harassment", "inappropriate", "spam", "other"
    ];

    const reason = reasons.includes(data?.reason)
      ? data.reason : "other";

    reports.set(reason, (reports.get(reason) || 0) + 1);

    // Temporary server log; not a complete moderation system.
    console.log("Report received:", {
      reason,
      reportedSession: other,
      time: new Date().toISOString()
    });

    socket.emit("report_received");
    clearPair(socket.id, "reported");
  });

  socket.on("disconnect", () => {
    clearPair(socket.id, "disconnected");
    removeFromQueue(socket.id);
    blocked.delete(socket.id);
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "HB Connect" });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HB Connect running on port ${PORT}`);
});
