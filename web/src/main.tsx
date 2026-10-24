import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Console } from "./console/Console.tsx";
import { Stage } from "./stage/Stage.tsx";
import "./styles.css";

function Home() {
  return (
    <main className="home">
      <h1>Sidequest</h1>
      <p>Gemini sees. Muse thinks. You conquer.</p>
      <nav>
        <a href="/stage?session=demo">Stage view (projector)</a>
        <a href="/console?session=demo">Console (phone / test harness)</a>
      </nav>
    </main>
  );
}

const routes: Record<string, () => React.ReactElement> = {
  "/stage": Stage,
  "/console": Console,
};
const Page = routes[location.pathname.replace(/\/$/, "")] ?? Home;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
