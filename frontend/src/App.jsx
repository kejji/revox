import { useState, useEffect } from "react";
import SignUp from "./SignUp";
import SignIn from "./SignIn";
import axios from "axios";
import { jwtDecode } from "jwt-decode";

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("token") || null);
  const [message, setMessage] = useState("");
  const [userInfo, setUserInfo] = useState(null);

  useEffect(() => {
    if (token) {
      localStorage.setItem("token", token);
      console.log("Token JWT :", token);
      // Decoder le token une seule fois pour extraire les infos utilisateur
      const decoded = jwtDecode(token);
      setUserInfo(decoded);
      axios.get("http://localhost:4000/dashboard", {
        headers: {
          Authorization: `Bearer ${token}`,
        }
      })
        .then(res => setMessage(res.data.message))
        .catch(err => {
          console.error("Erreur API protégée:", err);
          setMessage("Erreur lors de la récupération des données.");
        });
    }
  }, [token]);

  const handleLogout = async () => {
    try {
      await Auth.signOut(); // <-- déconnexion Amplify
    } catch (err) {
      console.warn("SignOut failed", err);
    }
    localStorage.removeItem("token");
    setToken(null);
  };

  if (!token) {
    return (
      <>
        <SignUp />
        <SignIn onSuccess={setToken} />
      </>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Revox Dashboard</h1>

      {userInfo && (
        <div className="my-4 p-4 bg-gray-100 rounded">
          <p><strong>Email :</strong> {userInfo.email}</p>
          <p><strong>ID utilisateur :</strong> {userInfo.sub}</p>
        </div>
      )}

      <p>{message}</p>

      <button
        className="mt-6 px-4 py-2 bg-red-600 text-white rounded"
        onClick={handleLogout}
      >
        Se déconnecter
      </button>
    </div>
  );
}
