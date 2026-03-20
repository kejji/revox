import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "access",
  clientId: process.env.COGNITO_APP_CLIENT_ID,
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