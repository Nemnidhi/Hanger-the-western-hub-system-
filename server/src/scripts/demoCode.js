// Prints the demo owner's current two-step login code (development only; see seedDemo.js).
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { currentStep, totpCode } from "../security/totp.js";

const config = loadConfig();
const secret = (await readFile(path.join(path.resolve(config.UPLOAD_DIR), ".demo-totp"), "utf8").catch(() => "")).trim();
if (!secret) {
  console.error("No demo secret: run node src/scripts/seedDemo.js first.");
  process.exit(1);
}
console.log(totpCode(secret, currentStep()));
