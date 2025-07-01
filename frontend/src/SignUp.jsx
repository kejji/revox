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
      <div className="p-4 bg-white rounded shadow max-w-md mx-auto mt-6">
        <h2 className="text-xl font-semibold mb-4">Create an account</h2>

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
          className="w-full bg-green-600 text-white p-2 rounded hover:bg-green-700"
          onClick={handleSignUp}
        >
          Sign Up
        </button>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="p-4 bg-white rounded shadow max-w-md mx-auto mt-6">
        <h2 className="text-xl font-semibold mb-4">Confirm your account</h2>

        <input
          className="w-full p-2 border border-gray-300 rounded mb-2"
          placeholder="Confirmation Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />

        {error && <p className="text-red-600 text-sm mb-2">{error}</p>}

        <button
          className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700"
          onClick={handleConfirm}
        >
          Confirm
        </button>
      </div>
    );
  }

  return (
    <p className="text-center mt-6 text-green-700 font-semibold">
      ✅ Registration complete! You can now log in.
    </p>
  );
}
