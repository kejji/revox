import { useState, useEffect } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import SignUp from "./SignUp";
import SignIn from "./SignIn";
import ExtractionStatus from "./ExtractionStatus";
import axios from "axios";
import { jwtDecode } from "jwt-decode";
import { Auth } from "aws-amplify";

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("token") || null);
  const [message, setMessage] = useState("");
  const [userInfo, setUserInfo] = useState(null);
  const [appName, setAppName] = useState("");
  const [iosAppId, setIosAppId] = useState("");
  const [androidAppId, setAndroidAppId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [extractStatus, setExtractStatus] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (token) {
      localStorage.setItem("token", token);
      console.log("Token JWT :", token);
      // Decoder le token une seule fois pour extraire les infos utilisateur
      const decoded = jwtDecode(token);
      setUserInfo(decoded);
      axios.get(`${import.meta.env.VITE_API_URL}/dashboard`, {
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

  const handleExtract = async () => {
    try {
      const body = {
        appName,
        iosAppId,
        androidAppId,
        fromDate,
        toDate,
      };
      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}/extract`,
        body,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      setExtractStatus(`ID extraction : ${res.data.extractionId}`);
      navigate(`/extraction/${res.data.extractionId}`);
    } catch (err) {
      console.error('Erreur extraction:', err);
      setExtractStatus("Erreur lors du lancement de l'extraction");
    }
  };

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

  const dashboard = (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Revox Dashboard</h1>

      {userInfo && (
        <div className="my-4 p-4 bg-gray-100 rounded">
          <p><strong>Email :</strong> {userInfo.email}</p>
          <p><strong>ID utilisateur :</strong> {userInfo.sub}</p>
        </div>
      )}

      <p>{message}</p>

      <div className="mt-6 space-y-2">
        <h2 className="text-lg font-semibold">Lancer une extraction</h2>
        <input
          className="w-full p-2 border border-gray-300 rounded"
          placeholder="Nom de l'application"
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
        />
        <input
          className="w-full p-2 border border-gray-300 rounded"
          placeholder="ID iOS"
          value={iosAppId}
          onChange={(e) => setIosAppId(e.target.value)}
        />
        <input
          className="w-full p-2 border border-gray-300 rounded"
          placeholder="ID Android"
          value={androidAppId}
          onChange={(e) => setAndroidAppId(e.target.value)}
        />
        <input
          className="w-full p-2 border border-gray-300 rounded"
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
        />
        <input
          className="w-full p-2 border border-gray-300 rounded"
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
        />
        <button
          className="w-full bg-green-600 text-white p-2 rounded"
          onClick={handleExtract}
        >
          Lancer l'extraction
        </button>
        {extractStatus && <p className="text-sm">{extractStatus}</p>}
      </div>

      <button
        className="mt-6 px-4 py-2 bg-red-600 text-white rounded"
        onClick={handleLogout}
      >
        Se déconnecter
      </button>
    </div>
  );

  return (
    <Routes>
      <Route path="/" element={dashboard} />
      <Route path="/extraction/:id" element={<ExtractionStatus token={token} />} />
    </Routes>
  );
}
