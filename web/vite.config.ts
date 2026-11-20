import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE is the folder the app is served from. Vercel serves it from "/".
// GitHub Pages serves it from "/<repository name>/", set by the Pages workflow.
export default defineConfig({ base: process.env.VITE_BASE || "/", plugins: [react()] });
