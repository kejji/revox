import { CognitoJwtVerifier } from "aws-jwt-verify";
import dotenv from "dotenv";
dotenv.config();

const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_APP_CLIENT_ID;

console.log("COGNITO_USER_POOL_ID:", userPoolId);
console.log("COGNITO_APP_CLIENT_ID:", clientId);

const verifier = CognitoJwtVerifier.create({
  userPoolId,
  tokenUse: "access",
  clientId,
});

export async function requireAuth(req, res, next) {
  if (req.method === "OPTIONS") return next();
  if (req.path === "/health") return next();

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const payload = await verifier.verify(token);

    // token valide
    req.auth = {
      sub: payload.sub,
      claims: payload,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}