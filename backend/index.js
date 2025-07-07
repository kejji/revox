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

// extraire le sub Cognito (via Authorization header)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.split(" ")[1];
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      req.auth = { sub: payload.sub };
    } catch (err) {
      console.warn("Token malformé :", err.message);
    }
  }
  next();
});

// Route publique
app.get("/health", (_, res) => res.send({ status: "OK" }));

// Route dashboard protégée via API GW
app.get("/dashboard", (req, res) => {
  if (!req.auth?.sub) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ message: "Données sensibles pour " + req.auth.sub });
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
