import { useState } from "react";
import { Auth } from "aws-amplify";

export default function SignUp() {
  const [step, setStep] = useState("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const handleSignUp = async () => {
    try {
      await Auth.signUp({ username: email, password, attributes: { email } });
      setStep("confirm");
    } catch (err) {
      console.error("SignUp error:", err);
    }
  };

  const handleConfirm = async () => {
    try {
      await Auth.confirmSignUp(email, code);
      console.log("User confirmed");
      setStep("done");
    } catch (err) {
      console.error("Confirm error:", err);
    }
  };

  if (step === "signup") {
    return (
      <div>
        <input placeholder="Email" onChange={(e) => setEmail(e.target.value)} />
        <input type="password" placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
        <button onClick={handleSignUp}>Sign Up</button>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div>
        <input placeholder="Confirmation Code" onChange={(e) => setCode(e.target.value)} />
        <button onClick={handleConfirm}>Confirm</button>
      </div>
    );
  }

  return <p>Inscription terminée ! Vous pouvez maintenant vous connecter.</p>;
}
