import { useState } from "react";
import { Auth } from "aws-amplify";

export default function SignIn({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSignIn = async () => {
    try {
      const user = await Auth.signIn(email, password);
      const token = user.signInUserSession.idToken.jwtToken;
      onSuccess(token);
    } catch (err) {
      console.error("SignIn error:", err);
    }
  };

  return (
    <div>
      <input placeholder="Email" onChange={(e) => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
      <button onClick={handleSignIn}>Sign In</button>
    </div>
  );
}
