import React from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router-dom";
import {App} from "./app/App";
import "./theme.css";
// Geometry governance is intentionally loaded after the legacy feature sheets.
// Keep its contracts central instead of reintroducing per-page square corners.
import "./visualSystem.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
