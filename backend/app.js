// backend/app.js
import dotenv from "dotenv/config";
import express from "express";
import cors from "cors";
import decodeJwtSub from "./auth.js";
import { searchApp } from "./searchApp.js";
import { listReviews } from "./reviews.js";
import { exportReviewsCsv } from "./reviewsExport.js";
import { dispatchIncrementalIngest } from "./ingest.js";
import { followApp, unfollowApp, getFollowedApps, markFollowRead } from "./followApp.js";
import { upsertSchedule, getSchedule, listSchedules } from "./schedule.js";
import { mergeApps, unmergeApps } from "./appsMerge.js";
import { enqueueThemes } from "./themesEnqueue.js";
import { getThemesStatus } from "./themesStatus.js";
import { getThemesResult } from "./themesResult.js";
import { upsertThemesSchedule, getThemesSchedule, listThemesSchedules } from "./themesScheduleApi.js";

const app = express();

const allowedOrigins = ["http://localhost:8080",
  "https://lovable.dev",
  "https://preview--revox-frontend.lovable.app",
  "https://lovable.app",
  "https://c9a1ce22-5aa0-4154-9698-a80bfd723859.lovableproject.com",
  "https://id-preview--c9a1ce22-5aa0-4154-9698-a80bfd723859.lovable.app",
  "https://c9a1ce22-5aa0-4154-9698-a80bfd723859.sandbox.lovable.dev",
  "https://gptengineer-revox-83bd2a.lovable.app"
];

const corsOptions = {
  origin: (origin, cb) => {
    // autorise aussi les requêtes sans Origin (ex: curl, health checks)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  optionsSuccessStatus: 204, // 204 pour un préflight propre
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    // Les en-têtes ci-dessous sont posés par cors(), mais on peut être redondant
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || allowedOrigins[0]);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json());
app.use(decodeJwtSub);

app.get("/health", (_, res) => res.send({ status: "OK" }));

app.get("/dashboard", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  res.json({ message: "Données sensibles pour " + req.auth.sub });
});

app.get("/search-app", searchApp);

app.get("/reviews", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  listReviews(req, res);
});

app.get("/reviews/export", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  exportReviewsCsv(req, res);
});

app.post("/reviews/ingest", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  dispatchIncrementalIngest(req, res);
});

app.post("/follow-app", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  followApp(req, res);
});

app.delete("/follow-app", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  unfollowApp(req, res);
});

app.get("/follow-app", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  getFollowedApps(req, res);
});

app.get("/ingest/schedule", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  getSchedule(req, res);
});

app.put("/ingest/schedule", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  upsertSchedule(req, res);
});

app.get("/ingest/schedule/list", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  listSchedules(req, res);
});

app.post("/apps/merge", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  mergeApps(req, res);
});

app.delete("/apps/merge", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  unmergeApps(req, res);
});

app.put("/follow-app/mark-read", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  markFollowRead(req, res);
});

app.post("/themes/enqueue", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  enqueueThemes(req, res);
});

app.get("/themes/status", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  getThemesStatus(req, res);
});

app.get("/themes/result", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  getThemesResult(req, res);
});

app.get("/themes/schedule", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  getThemesSchedule(req, res);
});

app.put("/themes/schedule", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  upsertThemesSchedule(req, res);
});

app.get("/themes/schedule/list", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  listThemesSchedules(req, res);
});

export default app;

if (process.env.LOCAL === "true") {
  app.listen(4000, () => console.log("API on http://localhost:4000"));
}