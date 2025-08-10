import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Auth } from "aws-amplify";

const ExtractForm = () => {
  const [step, setStep] = useState(1);
  const [selectedApps, setSelectedApps] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState({
    startDate: "",
    endDate: "",
  });

  const navigate = useNavigate();

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    try {
      setLoading(true);
      const response = await fetch(`${import.meta.env.VITE_API_URL}/search-app?query=${searchQuery}`);
      const data = await response.json();

      setSelectedApps([]);
      setSearchResults(data);
    } catch (err) {
      console.error("Erreur lors de la recherche :", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchExtraction = async (body) => {
    const session = await Auth.currentSession();
    const token = session.getIdToken().getJwtToken();

    const response = await fetch(`${import.meta.env.VITE_API_URL}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error("Échec de l'extraction");

    const data = await response.json();
    return data.extractionId;
  };

  const handleExtract = async () => {
    const calls = selectedApps.map((app) =>
      fetchExtraction({
        appName: app.name,
        appId: app.id,
        platform: app.store,
        fromDate: dateRange.startDate,
        toDate: dateRange.endDate,
      })
    );

    try {
      const extractionIds = await Promise.all(calls);
      localStorage.setItem("extractions", JSON.stringify(extractionIds));
      navigate("/status");
    } catch (err) {
      console.error("Erreur lors de l'extraction :", err);
      alert("Une erreur est survenue lors de l'extraction.");
    }
  };

  const isSelected = (app) => {
    return selectedApps.some((a) => a.id === app.id && a.store === app.store);
  };

  const isDisabled = (app) => {
    const alreadySelected = isSelected(app);
    return !alreadySelected && selectedApps.length >= 2;
  };

  const toggleSelection = (app) => {
    const exists = isSelected(app);
    if (exists) {
      setSelectedApps((prev) =>
        prev.filter((a) => !(a.id === app.id && a.store === app.store))
      );
    } else {
      setSelectedApps((prev) => [...prev, app]);
    }
  };

  const handleLogout = async () => {
    try {
      await Auth.signOut();
      navigate("/signin");
    } catch (err) {
      console.error("Erreur lors de la déconnexion :", err);
    }
  };

  const groupedApps = searchResults.reduce((acc, app) => {
    if (!acc[app.name]) acc[app.name] = { icon: app.icon };
    acc[app.name][app.store] = app;
    return acc;
  }, {});

  return (
    <div style={{ maxWidth: "800px", margin: "auto", padding: "2rem" }}>
      {step === 1 && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
            <button onClick={handleLogout} style={{ backgroundColor: "#eee", padding: "0.5rem 1rem", borderRadius: "6px", cursor: "pointer" }}>
              Se déconnecter
            </button>
          </div>
          <h2>Étape 1 : Recherche et sélection d'apps</h2>

          <div style={{ marginBottom: "1rem" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Nom de l'application"
              style={{ width: "70%", padding: "0.5rem" }}
            />
            <button onClick={handleSearch} style={{ marginLeft: "1rem" }}>
              Rechercher
            </button>
          </div>
          {loading && <p>Chargement en cours...</p>}
          {Object.keys(groupedApps).length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>App</th>
                  <th style={{ textAlign: "center" }}>
                    <img src="https://upload.wikimedia.org/wikipedia/commons/f/fa/Apple_logo_black.svg" alt="iOS" width="20" />
                  </th>
                  <th style={{ textAlign: "center" }}>
                    <img src="https://upload.wikimedia.org/wikipedia/commons/d/d7/Android_robot.svg" alt="Android" width="20" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(groupedApps).map(([name, stores]) => (
                  <tr key={name} style={{ borderBottom: "1px solid #ccc" }}>
                    <td style={{ padding: "0.5rem", display: "flex", alignItems: "center" }}>
                      <img src={stores.icon} alt={name} style={{ width: 32, height: 32, marginRight: "0.5rem" }} />
                      {name}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        disabled={!stores.ios || isDisabled(stores.ios)}
                        checked={stores.ios ? isSelected(stores.ios) : false}
                        onChange={() => toggleSelection(stores.ios)}
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        disabled={!stores.android || isDisabled(stores.android)}
                        checked={stores.android ? isSelected(stores.android) : false}
                        onChange={() => toggleSelection(stores.android)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <button
            onClick={() => setStep(2)}
            disabled={selectedApps.length === 0}
            style={{ marginTop: "1rem" }}
          >
            Suivant
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <h2>Étape 2 : Choix de la période</h2>

          <div style={{ marginBottom: "1rem" }}>
            <label>Date de début :</label>
            <input
              type="date"
              value={dateRange.startDate}
              onChange={(e) =>
                setDateRange((prev) => ({
                  ...prev,
                  startDate: e.target.value,
                }))
              }
              style={{ marginLeft: "1rem" }}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label>Date de fin :</label>
            <input
              type="date"
              value={dateRange.endDate}
              onChange={(e) =>
                setDateRange((prev) => ({
                  ...prev,
                  endDate: e.target.value,
                }))
              }
              style={{ marginLeft: "2rem" }}
            />
          </div>

          <div style={{ marginTop: "2rem" }}>
            <button onClick={() => setStep(1)}>Retour</button>
            <button
              onClick={handleExtract}
              disabled={!dateRange.startDate || !dateRange.endDate}
              style={{ marginLeft: "1rem" }}
            >
              Lancer l'extraction
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ExtractForm;