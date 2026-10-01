import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" so the service can serve ui/dist from any mount path
export default defineConfig({ base: "./", plugins: [react()], server: { proxy: { "/v1": "http://127.0.0.1:7777" } } });
