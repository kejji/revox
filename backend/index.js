require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { checkJwt } = require("./auth");

const app = express();
app.use(cors());
app.use(express.json());

// Route publique
app.get("/health", (_, res) => res.send({ status: "OK" }));

// Route protégée
app.get("/dashboard", checkJwt, (req, res) => {
  res.json({ message: "Données sensibles pour " + req.auth.sub });
});

// Ce bloc est utilisé en local uniquement
if (process.env.LOCAL === "true") {
  app.listen(4000, () => console.log("API on http://localhost:4000"));
}

// Export du handler Lambda
const awsServerlessExpress = require("aws-serverless-express");
const server = awsServerlessExpress.createServer(app);
exports.handler = (event, context) => awsServerlessExpress.proxy(server, event, context);
