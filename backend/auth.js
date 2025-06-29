require("dotenv").config();
const { expressjwt: jwt } = require("express-jwt");
const jwksRsa = require("jwks-rsa");

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://cognito-idp.eu-west-3.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  }),
  audience: process.env.COGNITO_APP_CLIENT_ID,
  issuer: `https://cognito-idp.eu-west-3.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
  algorithms: ["RS256"],
});

module.exports = { checkJwt };
