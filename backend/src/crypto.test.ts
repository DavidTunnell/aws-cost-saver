import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto";

describe("crypto", () => {
  describe("encrypt/decrypt roundtrip", () => {
    it("encrypts and decrypts a simple string", () => {
      const plaintext = "hello world";
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("encrypts and decrypts an empty string", () => {
      const encrypted = encrypt("");
      expect(decrypt(encrypted)).toBe("");
    });

    it("encrypts and decrypts a long string (10KB)", () => {
      const plaintext = "a".repeat(10240);
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("encrypts and decrypts special characters (unicode, emojis)", () => {
      const plaintext = "Hello \u00e9\u00e0\u00fc\u00f1 \ud83d\ude80\ud83c\udf1f \u4f60\u597d \u0410\u0411\u0412";
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("handles AWS-like credential strings", () => {
      const accessKey = "AKIAIOSFODNN7EXAMPLE";
      const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      expect(decrypt(encrypt(accessKey))).toBe(accessKey);
      expect(decrypt(encrypt(secretKey))).toBe(secretKey);
    });
  });

  describe("encryption properties", () => {
    it("produces different ciphertexts for different plaintexts", () => {
      const enc1 = encrypt("hello");
      const enc2 = encrypt("world");
      expect(enc1).not.toBe(enc2);
    });

    it("produces different ciphertexts for same plaintext (random IV)", () => {
      const enc1 = encrypt("hello");
      const enc2 = encrypt("hello");
      expect(enc1).not.toBe(enc2);
      // But both decrypt to the same value
      expect(decrypt(enc1)).toBe("hello");
      expect(decrypt(enc2)).toBe("hello");
    });

    it("output format is iv:authTag:ciphertext (hex)", () => {
      const encrypted = encrypt("test");
      const parts = encrypted.split(":");
      expect(parts).toHaveLength(3);
      // IV = 16 bytes = 32 hex chars
      expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
      // Auth tag = 16 bytes = 32 hex chars
      expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
      // Ciphertext is hex
      expect(parts[2]).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("decryption error handling", () => {
    it("throws on tampered ciphertext", () => {
      const encrypted = encrypt("secret data");
      const parts = encrypted.split(":");
      // Tamper with ciphertext
      const tampered = parts[0] + ":" + parts[1] + ":ff" + parts[2].slice(2);
      expect(() => decrypt(tampered)).toThrow();
    });

    it("throws on tampered auth tag", () => {
      const encrypted = encrypt("secret data");
      const parts = encrypted.split(":");
      // Tamper with auth tag — replace entire tag with zeros
      const tampered = parts[0] + ":" + "00".repeat(16) + ":" + parts[2];
      expect(() => decrypt(tampered)).toThrow();
    });

    it("throws on malformed input (missing parts)", () => {
      expect(() => decrypt("not-valid-format")).toThrow();
    });

    it("throws on empty string input", () => {
      expect(() => decrypt("")).toThrow();
    });

    it("throws on tampered IV", () => {
      const encrypted = encrypt("secret data");
      const parts = encrypted.split(":");
      // Replace IV with all zeros
      const tampered = "00".repeat(16) + ":" + parts[1] + ":" + parts[2];
      expect(() => decrypt(tampered)).toThrow();
    });

    it("throws on invalid hex characters", () => {
      expect(() => decrypt("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz:zzzz")).toThrow();
    });

    it("throws on short IV/authTag lengths", () => {
      expect(() => decrypt("ff:ff:ff")).toThrow();
    });
  });
});
