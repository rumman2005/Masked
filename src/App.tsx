import { useEffect, useState } from "react";
import { io } from "socket.io-client";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const socketUrl = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

const statusText: Record<ConnectionStatus, string> = {
  connecting: "Connecting to backend…",
  connected: "Connected to backend",
  disconnected: "Disconnected from backend",
};

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");

  useEffect(() => {
    const socket = io(socketUrl);

    const handleConnect = () => setConnectionStatus("connected");
    const handleDisconnect = () => setConnectionStatus("disconnected");
    const handleConnectionError = () =>
      setConnectionStatus("disconnected");

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectionError);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectionError);
      socket.disconnect();
    };
  }, []);

  return (
    <main className="page-shell">
      <div className="container">
        <div className="row justify-content-center">
          <section className="col-12 col-md-8" aria-labelledby="app-title">
            <div className="panel">
              <header>
                <h1 id="app-title">MASKED</h1>
                <p>Module 1 client</p>
              </header>

              <div className="status-block" aria-live="polite">
                <span
                  className={`status-indicator status-${connectionStatus}`}
                  aria-hidden="true"
                />
                <span>{statusText[connectionStatus]}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

export default App;
