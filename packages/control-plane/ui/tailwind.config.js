// The UI styles itself with plain CSS variables (src/styles.css); Tailwind stays only so the existing PostCSS pipeline keeps working.
export default { content: ["./index.html", "./src/**/*.{ts,tsx}"], theme: { extend: {} }, plugins: [] };
