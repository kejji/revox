import { useState } from "react";
import { Auth } from "aws-amplify";

export default function SignIn({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

  const handleSignIn = async () => {
    try {
      const user = await Auth.signIn(email, password);

      // ✅ Récupérer le bon token JWT pour appel API sécurisé
      const token = user.signInUserSession.idToken.jwtToken;

      // Sauvegarder dans le parent (App.jsx)
      onSuccess(token);
      setError(null);
    } catch (err) {
      console.error("SignIn error:", err);
      setError("Incorrect email or password");
    }
  };

  return (
    <div className="container">
      <div className="card">
        <h2>Sign In</h2>

        <input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p style={{ color: '#dc2626' }}>{error}</p>}

        <button className="btn btn-primary" onClick={handleSignIn}>
          Sign In
        </button>
      </div>
    </div>
  );
}
