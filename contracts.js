// EIP-55 casing is not required for discovery; the address is normalized to lowercase.
const EVM = /(?<![a-zA-Z0-9])0x[a-fA-F0-9]{40}(?![a-zA-Z0-9])/g;
// Base58 public keys are 32-44 chars. Validation below prevents arbitrary prose matching.
// The broader alphanumeric boundaries prevent matching the `x...` suffix of an EVM 0x address.
const SOLANA = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

function isLikelySolanaAddress(value) {
  // A Solana public key encoded with base58 is normally 32 bytes and therefore 32-44 characters.
  // Exclude all-numeric strings, which otherwise match some page IDs.
  return /[A-Za-z]/.test(value) && value.length >= 32 && value.length <= 44;
}

export function extractContracts(text) {
  const found = new Map();
  for (const value of text.match(EVM) ?? []) found.set(`evm:${value.toLowerCase()}`, { chain: 'evm', address: value.toLowerCase() });
  for (const value of text.match(SOLANA) ?? []) {
    if (isLikelySolanaAddress(value)) found.set(`solana:${value}`, { chain: 'solana', address: value });
  }
  return [...found.values()];
}

export const contractKey = ({ chain, address }) => `${chain}:${chain === 'evm' ? address.toLowerCase() : address}`;
