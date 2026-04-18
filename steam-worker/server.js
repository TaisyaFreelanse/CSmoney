import { createApp } from "./src/app.js";

const port = Number(process.env.PORT) || 3001;
const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      type: "steam_worker_listen",
      port,
      accounts: process.env.STEAM_ACCOUNTS ? "configured" : "missing",
      ts: Date.now(),
    }),
  );
});
