import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { useNavigate } from "react-router-dom";

export default function ExtractionStatus({ token }) {
  const { id } = useParams();
  const [status, setStatus] = useState("pending");
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let interval;

    async function fetchStatus() {
      try {
        const res = await axios.get(`${import.meta.env.VITE_API_URL}/extract/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setStatus(res.data.status);
        if (res.data.status === "done") {
          clearInterval(interval);
          // Récupération du lien S3
          const linkRes = await axios.get(`${import.meta.env.VITE_API_URL}/extract/${id}/download`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          setDownloadUrl(linkRes.data.url);
        }
      } catch (err) {
        console.error("Erreur statut extraction:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchStatus();
    interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [id, token]);

  return (
    <div className="p-6 text-center">
      <h2 className="text-xl font-bold mb-4">Statut de l'extraction</h2>
      <p className="mb-2">ID : {id}</p>
      <p className="mb-4">Status : {status}</p>

      {status === "pending" && (
        <div className="flex flex-col items-center">
          <div className="loader mb-4"></div>
          <p>Traitement en cours... Patiente un instant ☕</p>
        </div>
      )}

      {status === "done" && downloadUrl && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          📥 Télécharger le CSV
        </a>
      )}

      {status === "error" && (
        <p className="text-red-600 mt-4">Une erreur est survenue. Merci de réessayer plus tard.</p>
      )}
      <button
        onClick={() => navigate("/")}
        className="mt-6 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
      >
        🔙 Revenir au tableau de bord
      </button>
    </div>
  );
}
