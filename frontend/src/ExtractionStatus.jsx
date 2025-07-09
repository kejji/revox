import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Auth } from "aws-amplify";
import axios from "axios";

export default function ExtractionStatus({ token }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("pending");

  const handleLogout = async () => {
    try {
      await Auth.signOut();
    } catch (err) {
      console.warn("SignOut failed", err);
    }
    localStorage.removeItem("token");
    navigate("/");
  };

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await axios.get(`${import.meta.env.VITE_API_URL}/extract/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setStatus(res.data.status);
      } catch (err) {
        console.error("Erreur statut extraction:", err);
      }
    }
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [id, token]);

  return (
    <>
      <header>
        <button className="btn" onClick={() => navigate('/')}>⬅ Retour</button>
        <h1>Revox Dashboard</h1>
        <button className="btn btn-danger" onClick={handleLogout}>
          Se déconnecter
        </button>
      </header>
      <div className="container">
        <div className="card">
          <h2>Statut de l'extraction</h2>
          <p>ID : {id}</p>
          <p>Status : {status}</p>
        </div>
      </div>
    </>
  );
}
