// backend/app.js
import express from "express";
import cors from "cors";
import decodeJwtSub from "./auth.js";
import { createExtraction, getExtractionStatus, downloadExtraction } from "./extract.js";
import { searchApp } from "./searchApp.js";
import { listReviews } from "./reviews.js";
import { exportReviewsCsv } from "./reviewsExport.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(decodeJwtSub);

app.get("/health", (_, res) => res.send({ status: "OK" }));

app.get("/dashboard", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  res.json({ message: "Données sensibles pour " + req.auth.sub });
});

app.post("/extract", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  createExtraction(req, res);
});

app.get("/extract/:id", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  getExtractionStatus(req, res);
});

app.get("/extract/:id/download", (req, res) => {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  downloadExtraction(req, res);
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

export default app;

if (process.env.LOCAL === "true") {
  app.listen(4000, () => console.log("API on http://localhost:4000"));
}