// extraire le sub Cognito (via Authorization header)
module.exports = function decodeJwtSub(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.split(" ")[1];
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64").toString()
      );
      req.auth = { sub: payload.sub };
    } catch (err) {
      console.warn("Token malformé ou non décodable :", err.message);
    }
  }
  next();
};
