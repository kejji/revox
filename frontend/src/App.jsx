import { useEffect, useState } from "react";

function App() {
  const [status, setStatus] = useState("loading...");

  useEffect(() => {
    fetch("http://localhost:4000/health")
      .then(res => res.json())
      .then(data => setStatus(data.status));
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Revox</h1>
      <p>Status: {status}</p>
    </div>
  );
}

export default App;
