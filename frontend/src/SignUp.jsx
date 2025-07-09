import { useState } from "react";
import { Auth } from "aws-amplify";

export default function SignUp() {
  const [step, setStep] = useState("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);

  const handleSignUp = async () => {
    try {
      await Auth.signUp({
        username: email,
        password,
        attributes: { email },
      });
      setStep("confirm");
      setError(null);
    } catch (err) {
      console.error("SignUp error:", err);
      setError(err.message || "Une erreur est survenue.");
    }
  };

  const handleConfirm = async () => {
    try {
      await Auth.confirmSignUp(email, code);
      setStep("done");
      setError(null);
    } catch (err) {
      console.error("Confirm error:", err);
      setError(err.message || "Erreur de confirmation.");
    }
  };

  if (step === "signup") {
    return (
      <div className="container">
        <div className="card">
          <h2>Create an account</h2>

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

          {error && <p style={{ color: "#dc2626" }}>{error}</p>}

          <button className="btn btn-primary" onClick={handleSignUp}>
            Sign Up
          </button>
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="container">
        <div className="card">
          <h2>Confirm your account</h2>

          <input
            placeholder="Confirmation Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />

          {error && <p style={{ color: "#dc2626" }}>{error}</p>}

          <button className="btn btn-primary" onClick={handleConfirm}>
            Confirm
          </button>
        </div>
      </div>
    );
  }

  return (
    <p className="container" style={{ color: '#16a34a', textAlign: 'center' }}>
      ✅ Registration complete! You can now log in.
    </p>
  );
}
