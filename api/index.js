const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10kb" }));

/* ---------- MongoDB (cached across serverless invocations) ---------- */
const MONGODB_URI = process.env.MONGODB_URI;

const userSchema = new mongoose.Schema(
  {
    chat_id: { type: Number, required: true, unique: true, index: true },
    username: { type: String, default: null },
    first_name: { type: String, default: "" },
  },
  { timestamps: true }
);
const User = mongoose.models.User || mongoose.model("User", userSchema);

let cached = global._mongoose;
if (!cached) cached = global._mongoose = { conn: null, promise: null };

async function connectDB() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI env var is not set");
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, { bufferCommands: false, serverSelectionTimeoutMS: 8000 })
      .then((m) => m);
  }
  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null; // allow retry on next request
    throw err;
  }
  return cached.conn;
}

/* ---------- POST /api/register ---------- */
app.post("/api/register", async (req, res) => {
  try {
    const { chat_id, username, first_name } = req.body || {};
    const id = Number(chat_id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "chat_id is required" });
    }
    await connectDB();
    const user = await User.findOneAndUpdate(
      { chat_id: id },
      { $set: { username: username || null, first_name: first_name || "" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, chat_id: user.chat_id });
  } catch (err) {
    console.error("[register]", err.message);
    res.status(500).json({ ok: false, error: "Registration failed" });
  }
});

/* ---------- GET /api/extract?url=... (CORS proxy) ---------- */
const UPSTREAM = "https://nebula.playterabox.com/api/filesadda?url=";

app.get("/api/extract", async (req, res) => {
  const url = req.query.url;
  if (typeof url !== "string" || !url.trim() || url.length > 2048) {
    return res.status(400).json({ ok: false, error: "A valid url query parameter is required" });
  }
  try {
    const upstream = await axios.get(UPSTREAM + encodeURIComponent(url.trim()), {
      timeout: 20000,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    res.set("Cache-Control", "no-store");
    res.status(200).json(upstream.data);
  } catch (err) {
    const status = err.response ? err.response.status : 502;
    console.error("[extract]", status, err.message);
    res.status(status >= 400 && status < 600 ? status : 502).json({
      ok: false,
      error: "Could not fetch the video link. Please try again.",
    });
  }
});

app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "Not found" }));

module.exports = app;

// Local dev: `MONGODB_URI=... node api/index.js`
if (require.main === module) {
  const port = process.env.PORT || 3000;
  const path = require("path");
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.listen(port, () => console.log(`http://localhost:${port}`));
}
