import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// The crypto/packaging modules live in ../lib and are shared with the Hardhat
// scripts, so there is exactly one implementation of certId, hashing and
// encryption. The alias plus fs.allow lets Vite pull them in from outside
// the frontend folder.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@lib": path.resolve(__dirname, "../lib") },
  },
  server: {
    fs: { allow: [path.resolve(__dirname, ".."), path.resolve(__dirname)] },
  },
});
