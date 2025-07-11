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
      console.log("User Pool ID:", import.meta.env.VITE_COGNITO_USER_POOL_ID);
      setError("Incorrect email or password");
    }
  };

  return (
    <div className="p-4 bg-white rounded shadow max-w-md mx-auto my-6">
      <h2 className="text-xl font-semibold mb-4">Sign In</h2>

      <input
        className="w-full p-2 border border-gray-300 rounded mb-2"
        placeholder="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <input
        className="w-full p-2 border border-gray-300 rounded mb-2"
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      {error && <p className="text-red-600 text-sm mb-2">{error}</p>}

      <button
        className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700"
        onClick={handleSignIn}
      >
        Sign In
      </button>
    </div>
  );
}
