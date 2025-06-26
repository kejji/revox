const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_, res) => res.send({ status: "OK", app: "Revox" }));

app.listen(4000, () => console.log("API running on http://localhost:4000"));

