require("dotenv").config();
const checkJwt = (_, __, next) => next();
module.exports = { checkJwt };
