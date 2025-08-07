import React, { useState } from "react";
import { Auth } from "aws-amplify";
import { useNavigate } from "react-router-dom";

const ExtractForm = () => {
  const [step, setStep] = useState(1);
  const [selectedApps, setSelectedApps] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [dateRange, setDateRange] = useState({
    startDate: "",
    endDate: "",
  });

  const navigate = useNavigate();

  const handleNext = () => setStep(2);
  const handleBack = () => setStep(1);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/search-app?query=${searchQuery}`);
      const data = await response.json();
      setSelectedApps([]);
      setSearchResults(data);
    } catch (err) {
      console.error("Erreur lors de la recherche :", err);
    }
  };

  const handleExtract = async () => {
    try {
      const calls = selectedApps.map((app) =>
        fetchExtraction({
          appName: app.name,
          appId: app.id,
          platform: app.store,
          fromDate: dateRange.startDate,
          toDate: dateRange.endDate,
        })
      );

      const extractionIds = await Promise.all(calls);

      // Sauvegarder dans localStorage
      localStorage.setItem("extractions", JSON.stringify(extractionIds));
      // Rediriger vers /status
      navigate("/status");

    } catch (err) {
      console.error("Erreur lors de l'extraction :", err);
      alert("Une erreur est survenue lors de l'extraction.");
    }
  };

  const fetchExtraction = async (body) => {
    const session = await Auth.currentSession();
    const token = session.getIdToken().getJwtToken();

    const response = await fetch(`${import.meta.env.VITE_API_URL}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error("Échec de l'extraction");
    }

    const data = await response.json();
    return data.extractionId;
  };

  // 🧠 Grouper les apps par nom
  const groupedApps = searchResults.reduce((acc, app) => {
    if (!acc[app.name]) acc[app.name] = {};
    acc[app.name][app.store] = app;
    return acc;
  }, {});

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

  return (
    <div style={{ textAlign: "left", maxWidth: "700px", margin: "auto" }}>
      {step === 1 && (
        <div>
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

          {Object.keys(groupedApps).length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Nom de l'app</th>
                    <th>iOS</th>
                    <th>Android</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(groupedApps).map(([name, stores]) => (
                    <tr key={name}>
                      <td>{name}</td>
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
            </div>
          )}

          {Object.keys(groupedApps).length === 0 && searchResults.length > 0 && (
            <p>Aucune app affichable.</p>
          )}

          <button
            onClick={handleNext}
            disabled={selectedApps.length === 0}
            style={{ marginTop: "1rem" }}
          >
            Suivant
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
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
            <button onClick={handleBack}>Retour</button>
            <button
              onClick={handleExtract}
              disabled={!dateRange.startDate || !dateRange.endDate}
              style={{ marginLeft: "1rem" }}
            >
              Lancer l'extraction
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExtractForm;