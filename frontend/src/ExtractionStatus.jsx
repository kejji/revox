import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";

export default function ExtractionStatus({ token }) {
  const { id } = useParams();
  const [status, setStatus] = useState("pending");

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
    <div className="p-6">
      <h2 className="text-xl font-bold mb-4">Statut de l'extraction</h2>
      <p className="mb-2">ID : {id}</p>
      <p>Status : {status}</p>
    </div>
  );
}
