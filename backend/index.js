require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { checkJwt } = require("./auth");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Route publique
app.get("/health", (_, res) => res.send({ status: "OK" }));

// 🔐 Route protégée
app.get("/dashboard", checkJwt, (req, res) => {
  // `req.auth.sub` contient l’ID de l’utilisateur Cognito
  res.json({ message: "Données sensibles pour " + req.auth.sub });
});

app.listen(4000, () => console.log("API on http://localhost:4000"));
