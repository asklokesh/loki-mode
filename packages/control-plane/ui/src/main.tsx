import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./shell/theme";
import "./design/fonts.css";
import "./design/tokens.css";
import "./index.css";

applyTheme();
createRoot(document.getElementById("root")!).render(<App />);
