import cpPreset from "./src/design/tailwind.preset.ts";

export default { presets: [cpPreset], content: ["./index.html", "./src/**/*.{ts,tsx}"], darkMode: ["class", '[data-theme="dark"]'], theme: { extend: {} }, plugins: [] };
