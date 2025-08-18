// backend/app.js
import express from "express";
import cors from "cors";
import decodeJwtSub from "./auth.js";
import { searchApp } from "./searchApp.js";
import { listReviews } from "./reviews.js";
import { exportReviewsCsv } from "./reviewsExport.js";
import { dispatchIncrementalIngest } from "./ingest.js";
import { followApp, unfollowApp, getFollowedApps } from "./followApp.js";

import dotenv from "dotenv";
dotenv.config();

const app = express();

const allowedOrigins = [ "http://localhost:8080", "https://lovable.dev", "https://preview--revox-frontend.lovable.app" ];

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

export default app;

if (process.env.LOCAL === "true") {
  app.listen(4000, () => console.log("API on http://localhost:4000"));
}