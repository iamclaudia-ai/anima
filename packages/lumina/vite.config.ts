import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [nitro()],
  nitro: {
    preset: "standard",
  },
  server: {
    allowedHosts: ["lumina.anima-sedes.com", "localhost"],
  },

});
