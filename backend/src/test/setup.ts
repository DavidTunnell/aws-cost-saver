// Set a fixed master encryption key for deterministic crypto tests
process.env.MASTER_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Disable LLM calls in tests
process.env.ANTHROPIC_API_KEY = "";
