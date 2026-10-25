import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Hub } from "./hub/Hub.tsx";
import "./styles.css";
import "./genie.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Hub />
  </StrictMode>,
);
