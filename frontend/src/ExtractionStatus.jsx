import React, { useEffect, useState } from "react";
import { Auth } from "aws-amplify";

const ExtractionStatus = () => {
  const [extractions, setExtractions] = useState([]);
  const [statuses, setStatuses] = useState({});

  // Récupère les IDs depuis le localStorage au chargement
  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem("extractions") || "[]");
    setExtractions(stored);
  }, []);

  // Fonction pour récupérer le statut d'une extraction
  const fetchStatus = async (id) => {
    const session = await Auth.currentSession();
    const token = session.getIdToken().getJwtToken();
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/extract/${id}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      return data.status; // 🟢 par exemple "pending", "in_progress", "done"
    } catch (err) {
      return "inconnu";
    }
  };

  // Rafraîchir tous les statuts
  const refreshStatuses = async () => {
    const results = {};
    for (const id of extractions) {
      const status = await fetchStatus(id);
      results[id] = status;
    }
    setStatuses(results);
  };

  // Fonction pour télécharger le fichier d'extraction
  const downloadCsv = async (id) => {
    try {
      const session = await Auth.currentSession();
      const token = session.getIdToken().getJwtToken();
  
      const response = await fetch(`${import.meta.env.VITE_API_URL}/extract/${id}/download`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
  
      if (!response.ok) throw new Error("Erreur lors de la récupération du lien de téléchargement");
  
      const data = await response.json();
      const downloadUrl = data.url;
  
      // 🔽 Créer un lien et simuler un clic
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `extraction-${id}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      alert("Impossible de télécharger le fichier.");
      console.error(err);
    }
  };

  // 🚀 Appel initial + boucle toutes les 10 secondes
  useEffect(() => {
    if (extractions.length === 0) return;

    refreshStatuses(); // premier appel

    const interval = setInterval(() => {
      refreshStatuses();
    }, 5000); // toutes les 5s

    return () => clearInterval(interval); // nettoyage du timer
  }, [extractions]);

  return (
    <div style={{ maxWidth: "600px", margin: "auto", padding: "2rem" }}>
      <h2>Suivi des extractions</h2>

      {extractions.length === 0 ? (
        <p>Aucune extraction trouvée.</p>
      ) : (
        <ul>
          {extractions.map((id) => (
            <li key={id} style={{ marginBottom: "1rem" }}>
              <strong>ID :</strong> <code>{id}</code> –{" "}
              <strong>Statut :</strong> <span>{statuses[id] || "Chargement..."}</span>
              {statuses[id] === "done" && (
                <button
                  onClick={() => downloadCsv(id)}
                  style={{ marginLeft: "1rem" }}
                >
                  Télécharger le CSV
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ExtractionStatus;