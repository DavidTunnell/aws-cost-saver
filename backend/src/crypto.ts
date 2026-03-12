import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKeyDir(): string {
  const dir = path.join(os.homedir(), ".aws-cost-saver");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getMasterKey(): Buffer {
  if (process.env.MASTER_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.MASTER_ENCRYPTION_KEY, "hex");
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `MASTER_ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`
      );
    }
    return key;
  }

  const keyPath = path.join(getKeyDir(), "master.key");
  if (fs.existsSync(keyPath)) {
    return Buffer.from(fs.readFileSync(keyPath, "utf-8").trim(), "hex");
  }

  const key = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  console.log(`Generated master encryption key at ${keyPath}`);
  return key;
}

const masterKey = getMasterKey();

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(encoded: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}
