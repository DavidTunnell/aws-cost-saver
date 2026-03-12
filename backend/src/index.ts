import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Try multiple locations for .env
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "..", ".env"),
];
for (const envPath of candidates) {
  if (fs.existsSync(envPath)) {
    console.log("Loading .env from:", envPath);
    dotenv.config({ path: envPath, override: true });
    break;
  }
}

console.log("ANTHROPIC_API_KEY loaded:", process.env.ANTHROPIC_API_KEY ? "yes" : "NO");
import express from "express";
import cors from "cors";
import accountsRouter from "./routes/accounts";
import auditsRouter from "./routes/audits";

const app = express();
const PORT = parseInt(process.env.PORT || "8000", 10);

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.use("/api/accounts", accountsRouter);
app.use("/api/audits", auditsRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
