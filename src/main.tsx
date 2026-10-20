import "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { TranslationProvider } from "react-auto-google-translate";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TranslationProvider originalLang="ar">
      <App />
    </TranslationProvider>
  </React.StrictMode>
);
