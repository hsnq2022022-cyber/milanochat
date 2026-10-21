import "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { TranslationProvider } from "react-auto-google-translate";
import { GoogleTranslateBoundary } from "react-google-translate-shim";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <GoogleTranslateBoundary>
      <TranslationProvider originalLang="ar">
        <App />
      </TranslationProvider>
    </GoogleTranslateBoundary>
  </React.StrictMode>
);
