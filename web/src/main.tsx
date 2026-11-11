import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Guest } from "./Guest";
import { Host } from "./Host";
import { Screen } from "./Screen";

const path = location.pathname.replace(/\/+$/, "");
const Page = path === "/host" ? Host : path === "/screen" ? Screen : Guest;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
