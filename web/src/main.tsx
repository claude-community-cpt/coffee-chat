import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Guest } from "./Guest";
import { Host } from "./Host";
import { Screen } from "./Screen";
import { route } from "./route";

const page = route(location.pathname);
const Page = page === "host" ? Host : page === "screen" ? Screen : Guest;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
