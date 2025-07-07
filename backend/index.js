require("dotenv").config();

const AWS_REGION        = process.env.AWS_REGION;
const QUEUE_URL         = process.env.EXTRACTION_QUEUE_URL;
const EXTRACTIONS_TABLE = process.env.EXTRACTIONS_TABLE;

const express = require("express");
const cors    = require("cors");
const { checkJwt } = require("./auth");

// Import de la logique d’extraction
const { createExtraction } = require("./routes/extract");

const app = express();
app.use(cors());
app.use(express.json());

// Route publique
app.get("/health", (_, res) => res.send({ status: "OK" }));

// Route dashboard protégée via API GW
app.get("/dashboard", (req, res) => {
  res.json({ message: "Données sensibles" });
});

// Route protégée extraction
app.post("/extract", checkJwt, createExtraction);

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
