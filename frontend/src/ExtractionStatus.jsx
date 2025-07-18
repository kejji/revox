import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";

export default function ExtractionStatus({ token }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("pending");
  const [downloadUrl, setDownloadUrl] = useState("");

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await axios.get(`${import.meta.env.VITE_API_URL}/extract/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setStatus(res.data.status);
        if (res.data.status === "done") {
          try {
            const urlRes = await axios.get(`${import.meta.env.VITE_API_URL}/extract/${id}/download`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            setDownloadUrl(urlRes.data.url);
          } catch (err) {
            console.error("Erreur récupération URL de téléchargement:", err);
          }
        }
      } catch (err) {
        console.error("Erreur statut extraction:", err);
      }
    }
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [id, token]);

  return (
    <div className="p-6">
      <h2 className="text-xl font-bold mb-4">Statut de l'extraction</h2>
      <p className="mb-4">ID : {id}</p>
      {status === "pending" && (
        <div className="loader mb-4" />
      )}
      {status === "done" && (
        <button
          className="mb-4 bg-green-600 text-white p-2 rounded"
          onClick={() => window.location.href = downloadUrl}
        >
          Télécharger le CSV
        </button>
      )}
      <div>
        <button className="mt-4 bg-gray-300 p-2 rounded" onClick={() => navigate('/')}>Retour</button>
      </div>
    </div>
  );
}
