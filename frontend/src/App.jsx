import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import SignIn from "./SignIn";
import SignUp from "./SignUp";
import ExtractionStatus from "./ExtractionStatus";
import ExtractForm from "./ExtractForm";

function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/status" element={<ExtractionStatus />} />
      <Route path="/extract" element={<ExtractForm />} /> {/* ✅ Formulaire à 2 étapes */}
      {/* on peut aussi ajouter une route d'accueil si besoin */}
      <Route path="/" element={<SignIn />} />
    </Routes>
  );
}

export default App;