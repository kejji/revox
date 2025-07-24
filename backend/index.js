require("dotenv").config();

const AWS_REGION        = process.env.AWS_REGION;
const EXTRACTIONS_TABLE = process.env.EXTRACTIONS_TABLE;

const express = require("express");
const cors    = require("cors");

// Middleware
const decodeJwtSub = require("./auth");

// Import de la logique d’extraction
const { createExtraction, getExtractionStatus, downloadExtraction } = require("./extract");
const { searchApp } = require("./searchApp");

const app = express();
app.use(cors());
app.use(express.json());
app.use(decodeJwtSub);

// Route publique
app.get("/health", (_, res) => res.send({ status: "OK" }));

// Route dashboard protégée via API GW
app.get("/dashboard", (req, res) => {
  if (!req.auth?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ message: "Données sensibles pour " + req.auth.sub });
});

// Route extract protégée via API GW
app.post("/extract", (req, res) => {
  if (!req.auth?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  createExtraction(req, res);
});

// Récupérer le statut d'une extraction
app.get("/extract/:id", (req, res) => {
  if (!req.auth?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  getExtractionStatus(req, res);
});

// Télécharger le fichier
app.get("/extract/:id/download", (req, res) => {
  if (!req.auth?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  downloadExtraction(req, res);
});

// Rechercher une app
app.get("/search-app", (req, res) => {
  searchApp(req, res);
});

// Pour le dev local uniquement
if (process.env.LOCAL === "true") {
  app.listen(4000, () => console.log("API on http://localhost:4000"));
}

// Export du handler Lambda
const serverlessExpress = require("@vendia/serverless-express");
const server = serverlessExpress({ app });

exports.handler = (event, context) => {
  return server(event, context);
};
